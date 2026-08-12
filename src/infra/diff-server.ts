/**
 * ブラウザ編集用の一時 HTTP サーバー (§4.3 + §9)。
 *
 * セキュリティ設計 (2026-08-12 決定・同日 JS 解禁で更新):
 * - 127.0.0.1 のみで待ち受け (OS 割当の一時ポート)。外部への通信は行わない
 * - URL パス先頭に 128bit 乱数トークン。長さ検査の後 timingSafeEqual で比較し、
 *   不一致はルート不明と区別せず 404 (トークンの探索を許さない)
 * - Host ヘッダは 127.0.0.1:<port> 完全一致のみ (DNS rebinding 対策)。
 *   POST は Origin ヘッダが存在すれば自 origin 一致を要求
 * - ルートは固定 (一覧 / 編集ページ / 保存 / 終了)。対象はサーバー起動時に確定した
 *   エントリ配列の整数インデックスのみで、クライアントからパスは一切受け取らない
 * - POST は application/x-www-form-urlencoded のみ、ボディ上限 16 MiB
 * - JS はエディタページに埋め込んだ自前スクリプトのみ (script-src 'nonce-<応答ごとの乱数>')。
 *   外部リソース・外部ライブラリはゼロ。その他のページ/応答は JS 不可の基本 CSP
 * - 保存は symlink 拒否・isInsideRoot 再検証・sha256 楽観ロック (409) を通す
 *   (フォーム POST と fetch (ajax=1 → JSON 応答) の両対応。JS 無効でも保存できる)
 * - 無操作 idleTimeoutMs で自動終了 (textarea 入力はリクエストを発生させないため
 *   既定 30 分。短くしすぎると編集内容を失わせる)
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CSP, buildIndexPage, buildMessagePage, type IndexItem } from "../core/diff-html.ts";
import { buildEditorPage, editorCsp } from "../core/editor-html.ts";
import {
  browserEditBlockReason,
  findMergeUnencodable,
  mergeEditedText,
  renderTextareaValue,
} from "../core/edit.ts";
import { decodeFile, encodeDocument, type Eol, type FileDocument } from "../core/encoding.ts";
import type { Operation } from "../types.ts";
import { isInsideRoot, readFileState, sha256, writeBytes } from "./files.ts";

const BODY_LIMIT = 16 * 1024 * 1024;
const DEFAULT_IDLE_MS = 30 * 60_000;
const TOKEN_HEX_LEN = 32; // randomBytes(16) の hex

/** 同梱 monaco の場所 (src/ からも dist/ からも <パッケージ>/vendor/monaco) */
export function monacoVendorDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "monaco");
}

/**
 * 同梱資産の許可リストを起動時に列挙する (§9)。
 * 要求パスはこの Set への完全一致でのみ配信するため、ディレクトリトラバーサルは
 * 構造的に成立しない (".." を含むエントリは列挙に現れない)。
 */
function listVendorAssets(dir: string): Set<string> {
  const set = new Set<string>();
  const walk = (rel: string): void => {
    for (const ent of readdirSync(rel === "" ? dir : join(dir, rel), { withFileTypes: true })) {
      const relPath = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(relPath);
      else if (ent.isFile()) set.add(relPath);
    }
  };
  try {
    walk("");
  } catch {
    // 同梱なし (開発環境で gen:monaco 未実行) → 資産要求は 404
  }
  return set;
}

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

export interface EditEntry {
  /** ルート相対パス (呼び出し側で invalidPathReason 検証済み) */
  path: string;
  /** 絶対パス (呼び出し側で isInsideRoot 検証済み。保存時にも再検証する) */
  absPath: string;
  /** 比較の左側 (before / --mine 時は after)。null = 比較なし (create 等 → 空) */
  snapshotPath: string | null;
  op: Operation;
}

export interface DiffServerOptions {
  /** 一覧ページの見出し (例: `petari 履歴 2026-08-12_0930`) */
  title: string;
  entries: EditEntry[];
  /** プロジェクトルート (保存時の isInsideRoot 再検証用) */
  root: string;
  /** diff 左側のラベル (例: 適用前 (before)) */
  leftLabel: string;
  /** 改行を 1 つも持たないファイルへ行を追加した場合の改行 (config.newFile.eol) */
  fallbackEol: Eol;
  /** 無操作の自動終了までのミリ秒 (テスト用に注入可) */
  idleTimeoutMs?: number;
}

export interface DiffServerHandle {
  /** トークン付きの一覧 URL (末尾スラッシュあり) */
  url: string;
  /** サーバー終了で解決する ("quit" = 終了操作 / "idle" = 無操作タイムアウト) */
  closed: Promise<"quit" | "idle">;
  /** 即時終了 (テスト用。"quit" として解決する) */
  close(): void;
}

/** 保存処理の意味的な結果 (フォーム応答と JSON 応答の両方へ写像する) */
type SaveResult =
  | { kind: "saved"; sha: string }
  | { kind: "rejected"; status: number; message: string; back: string | null }
  | { kind: "unencodable"; message: string; text: string };

export async function startDiffServer(opts: DiffServerOptions): Promise<DiffServerHandle> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const idleMinutes = Math.max(1, Math.round(idleMs / 60_000));
  const token = randomBytes(16).toString("hex");
  const tokenBuf = Buffer.from(token);
  const vendorDir = monacoVendorDir();
  const vendorAssets = listVendorAssets(vendorDir);

  let resolveClosed: (reason: "quit" | "idle") => void;
  const closed = new Promise<"quit" | "idle">((resolve) => {
    resolveClosed = resolve;
  });
  let finished = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const shutdown = (reason: "quit" | "idle"): void => {
    if (finished) return;
    finished = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    server.close();
    server.closeAllConnections();
    resolveClosed(reason);
  };
  const resetIdle = (): void => {
    if (finished) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown("idle"), idleMs);
  };

  const baseHeaders = (contentType: string, csp: string): Record<string, string> => ({
    "content-type": contentType,
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  const send = (res: ServerResponse, status: number, html: string, csp?: string): void => {
    res.writeHead(status, baseHeaders("text/html; charset=utf-8", csp ?? CSP));
    res.end(html);
  };
  const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, baseHeaders("application/json; charset=utf-8", CSP));
    res.end(JSON.stringify(value));
  };

  const encodingLabel = (doc: FileDocument): string =>
    doc.encoding === "shift_jis" ? "Shift_JIS" : doc.hasBom ? "UTF-8 (BOM)" : "UTF-8";
  const eolLabel = (doc: FileDocument): string =>
    doc.eol === "crlf" ? "CRLF" : doc.eol === "lf" ? "LF" : "改行なし";

  /** エントリの編集可否 (一覧の注記)。null = 編集可 */
  const entryNote = (entry: EditEntry): string | null => {
    if (entry.op === "delete") return "delete のため現在のファイルはありません";
    const state = readFileState(entry.absPath);
    if (state.symlink) return "シンボリックリンクのため編集できません";
    if (!state.exists) return "ファイルが存在しません (undo 済み?)";
    try {
      return browserEditBlockReason(decodeFile(state.bytes as Uint8Array));
    } catch {
      return "テキストとして表示できません (バイナリまたはエンコーディング判定不能)";
    }
  };

  /** 編集ページを組み立てる。text/banner は保存失敗時の再表示用 (入力を失わせない) */
  const renderEditPage = (
    entry: EditEntry,
    saved: boolean,
    over?: { text?: string; banner?: string },
  ): { status: number; html: string; csp?: string } => {
    const back = "../";
    if (entry.op === "delete") {
      return {
        status: 200,
        html: buildMessagePage(entry.path, "delete のため現在のファイルはありません", back),
      };
    }
    const state = readFileState(entry.absPath);
    if (state.symlink) {
      return {
        status: 200,
        html: buildMessagePage(entry.path, "シンボリックリンクのため編集できません", back),
      };
    }
    if (!state.exists) {
      return {
        status: 200,
        html: buildMessagePage(entry.path, "ファイルが存在しません (undo 済み?)", back),
      };
    }
    const bytes = state.bytes as Uint8Array;
    let doc: FileDocument;
    try {
      doc = decodeFile(bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 200, html: buildMessagePage(entry.path, `編集できません: ${msg}`, back) };
    }
    let snapshotText: string | null = null;
    let snapshotNote: string | null = null;
    if (entry.snapshotPath !== null && existsSync(entry.snapshotPath)) {
      try {
        snapshotText = renderTextareaValue(
          decodeFile(new Uint8Array(readFileSync(entry.snapshotPath))),
        );
      } catch {
        snapshotNote = "スナップショットをテキスト表示できません (空との比較になります)";
      }
    } else {
      snapshotNote = "比較元スナップショットがありません (新規作成ファイル)";
    }
    const nonce = randomBytes(16).toString("base64");
    return {
      status: 200,
      csp: editorCsp(nonce),
      html: buildEditorPage({
        path: entry.path,
        leftLabel: opts.leftLabel,
        snapshotText,
        snapshotNote,
        currentText: over?.text ?? renderTextareaValue(doc),
        baseSha256: sha256(bytes),
        encodingLabel: encodingLabel(doc),
        eolLabel: eolLabel(doc),
        saved,
        errorBanner: over?.banner ?? null,
        blockReason: browserEditBlockReason(doc),
        idleMinutes,
        nonce,
      }),
    };
  };

  /** 保存の本体。応答形式 (フォーム/JSON) に依存しない意味的な結果を返す */
  const doSave = (entry: EditEntry, n: number, params: URLSearchParams): SaveResult => {
    const text = params.get("text");
    const base = params.get("baseSha256");
    if (text === null || base === null || !/^[0-9a-f]{64}$/.test(base)) {
      return { kind: "rejected", status: 400, message: "リクエストが不正です", back: "../" };
    }
    if (entry.op === "delete") {
      return { kind: "rejected", status: 403, message: "delete のため保存できません", back: "../" };
    }
    // 起動後のすり替えに備えて保存直前にも検証する (symlink / ルート外)
    if (!isInsideRoot(opts.root, entry.absPath)) {
      return { kind: "rejected", status: 403, message: "保存先がプロジェクト外です", back: "../" };
    }
    const state = readFileState(entry.absPath);
    if (state.symlink) {
      return {
        kind: "rejected",
        status: 403,
        message: "シンボリックリンクのため保存できません",
        back: "../",
      };
    }
    if (!state.exists) {
      return {
        kind: "rejected",
        status: 409,
        message: "ファイルが存在しません (削除された可能性)",
        back: "../",
      };
    }
    const bytes = state.bytes as Uint8Array;
    if (sha256(bytes) !== base) {
      return {
        kind: "rejected",
        status: 409,
        message:
          "ページを開いた後にファイルが外部で変更されています。開き直して編集を反映し直してください (今回の内容は保存されていません)",
        // POST 先 URL (/<token>/f/<n>) 基準の相対参照 = 編集ページ自身
        back: String(n),
      };
    }
    let doc: FileDocument;
    try {
      doc = decodeFile(bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "rejected", status: 403, message: `保存できません: ${msg}`, back: "../" };
    }
    const block = browserEditBlockReason(doc);
    if (block !== null) {
      return { kind: "rejected", status: 403, message: block, back: "../" };
    }
    const merged = mergeEditedText(doc, text);
    const bad = findMergeUnencodable(merged);
    if (bad.length > 0) {
      return {
        kind: "unencodable",
        message: `Shift_JIS に変換できない文字が含まれています: ${bad.join(" ")}`,
        text,
      };
    }
    const outBytes = encodeDocument(merged, opts.fallbackEol);
    const outSha = sha256(outBytes);
    if (outSha !== base) {
      writeBytes(entry.absPath, outBytes);
    }
    return { kind: "saved", sha: outSha };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    resetIdle();
    const port = (server.address() as AddressInfo).port;
    const selfOrigin = `http://127.0.0.1:${port}`;

    if (req.headers.host !== `127.0.0.1:${port}`) {
      send(res, 400, buildMessagePage("エラー", "不正なリクエストです", null));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", selfOrigin);
    } catch {
      send(res, 400, buildMessagePage("エラー", "不正なリクエストです", null));
      return;
    }
    const segs = url.pathname.split("/").filter((s) => s !== "");
    const first = segs[0] ?? "";
    const firstBuf = Buffer.from(first);
    if (firstBuf.length !== TOKEN_HEX_LEN || !timingSafeEqual(firstBuf, tokenBuf)) {
      send(res, 404, buildMessagePage("Not Found", "ページが見つかりません", null));
      return;
    }
    const rest = segs.slice(1);

    if (req.method === "GET") {
      if (rest.length === 0) {
        if (!url.pathname.endsWith("/")) {
          // 相対リンクの基準を保つため末尾スラッシュへ寄せる
          res.writeHead(308, { location: `/${token}/`, "cache-control": "no-store" });
          res.end();
          return;
        }
        const items: IndexItem[] = opts.entries.map((e) => ({
          path: e.path,
          op: e.op,
          note: entryNote(e),
        }));
        send(res, 200, buildIndexPage(opts.title, items, idleMinutes));
        return;
      }
      // 同梱 monaco 資産 (起動時に列挙した許可リストへの完全一致のみ配信)
      const assetKey = rest.join("/");
      if (vendorAssets.has(assetKey)) {
        const ext = assetKey.slice(assetKey.lastIndexOf("."));
        res.writeHead(200, baseHeaders(ASSET_TYPES[ext] ?? "application/octet-stream", CSP));
        res.end(readFileSync(join(vendorDir, ...rest)));
        return;
      }
      const n = parseEntryIndex(rest, opts.entries.length);
      if (n !== null) {
        const page = renderEditPage(
          opts.entries[n] as EditEntry,
          url.searchParams.get("saved") === "1",
        );
        send(res, page.status, page.html, page.csp);
        return;
      }
      send(res, 404, buildMessagePage("Not Found", "ページが見つかりません", "../"));
      return;
    }

    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== selfOrigin) {
        send(res, 403, buildMessagePage("エラー", "リクエスト元が不正です", null));
        return;
      }
      const ct = req.headers["content-type"];
      if (ct === undefined || !ct.startsWith("application/x-www-form-urlencoded")) {
        send(res, 415, buildMessagePage("エラー", "Content-Type が不正です", null));
        return;
      }
      const body = await readBody(req, BODY_LIMIT);
      if (body === null) {
        send(res, 413, buildMessagePage("エラー", "リクエストが大きすぎます", null));
        res.once("finish", () => req.destroy());
        return;
      }
      if (rest.length === 1 && rest[0] === "quit") {
        send(res, 200, buildMessagePage("終了しました", "サーバーを終了しました。このタブは閉じてください", null));
        // 応答を返してから閉じる
        setImmediate(() => shutdown("quit"));
        return;
      }
      const n = parseEntryIndex(rest, opts.entries.length);
      if (n !== null) {
        const entry = opts.entries[n] as EditEntry;
        const params = new URLSearchParams(body.toString("utf8"));
        const result = doSave(entry, n, params);
        if (params.get("ajax") === "1") {
          // fetch (自前 JS) 向け: JSON で結果を返す
          if (result.kind === "saved") sendJson(res, 200, { ok: true, baseSha256: result.sha });
          else if (result.kind === "unencodable") sendJson(res, 422, { ok: false, error: result.message });
          else sendJson(res, result.status, { ok: false, error: result.message });
          return;
        }
        // フォーム POST (JS 無効時のフォールバック) 向け
        if (result.kind === "saved") {
          res.writeHead(303, { location: `/${token}/f/${n}?saved=1`, "cache-control": "no-store" });
          res.end();
        } else if (result.kind === "unencodable") {
          const page = renderEditPage(entry, false, { text: result.text, banner: result.message });
          send(res, 200, page.html, page.csp);
        } else {
          send(res, result.status, buildMessagePage(result.status === 409 ? "競合" : "エラー", result.message, result.back));
        }
        return;
      }
      send(res, 404, buildMessagePage("Not Found", "ページが見つかりません", null));
      return;
    }

    send(res, 405, buildMessagePage("エラー", "許可されていないメソッドです", null));
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        send(res, 500, buildMessagePage("エラー", "内部エラーが発生しました", null));
      } catch {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  resetIdle();
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    closed,
    close: () => shutdown("quit"),
  };
}

/** ルート ["f", "<n>"] の <n> を検証して返す (それ以外は null)。先頭ゼロや符号は拒否 */
function parseEntryIndex(rest: string[], length: number): number | null {
  if (rest.length !== 2 || rest[0] !== "f") return null;
  const s = rest[1] as string;
  if (!/^(0|[1-9][0-9]*)$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n < length ? n : null;
}

/** ボディを上限付きで読む。超過・エラーは null */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        finish(null);
        return;
      }
      if (!done) chunks.push(c);
    });
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", () => finish(null));
  });
}
