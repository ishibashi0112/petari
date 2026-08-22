/**
 * petari show [ID] — 履歴の差分表示 (§4.3)。
 * - 既定: before vs after。VS Code の差分ビューで開き、VS Code が見つからない
 *   場合 (ENOENT/EINVAL) は自己完結 HTML レポートを生成してブラウザで開く
 * - --mine: after vs 現在のファイル = 適用後の手修正分だけを可視化
 * - --edit: スナップショット vs 現在の実ファイル。VS Code では右ペインが実ファイル
 *   (そのまま編集可)。VS Code がなければ 127.0.0.1 限定の一時サーバーでブラウザ編集
 * - --browser: VS Code を試さずブラウザ表示を強制
 * - --no-open: ブラウザを開かずパス/URL の表示のみ (SSH・テスト用)
 * - --changes: 保存済み changes.md の CHANGES セクションを表示
 * 複数ファイルの履歴は VS Code 経路では一覧から選択させ (--file で直接指定も可)、
 * ブラウザ経路では全ファイルをまとめて表示する。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { invalidPathReason } from "../core/applier.ts";
import { diffLines, toSideBySideRows } from "../core/diff.ts";
import { buildReportPage, type ReportFileSection } from "../core/diff-html.ts";
import { EncodingError, decodeFile } from "../core/encoding.ts";
import { parseChangesRecovering } from "../core/parser.ts";
import { openInBrowser } from "../infra/browser.ts";
import { loadConfig, type PetariConfig } from "../infra/config.ts";
import { monacoVendorDir, startDiffServer, type EditEntry } from "../infra/diff-server.ts";
import { isInsideRoot } from "../infra/files.ts";
import { historyRoot, listHistoryIds, readManifest, type ManifestFileEntry } from "../infra/history.ts";
import { createInterface } from "node:readline/promises";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";

const execFileP = promisify(execFile);

/**
 * vscodeCommand の形式制限 (セキュリティレビュー指摘 3)。
 * プロジェクト設定はリポジトリに同梱され得るため、リポジトリ内のスクリプトを
 * 指せる相対パス (./evil.sh 等) を拒否する。PATH 上のコマンド名か絶対パスのみ許可。
 */
export function invalidVscodeCommandReason(cmd: string): string | null {
  if (cmd.trim() === "") return "vscodeCommand が空です";
  if (cmd.startsWith("\\\\") || cmd.startsWith("//")) {
    return "vscodeCommand に UNC パスは使えません";
  }
  if ((cmd.includes("/") || cmd.includes("\\")) && !isAbsolute(cmd)) {
    return "vscodeCommand に相対パスは使えません (コマンド名または絶対パスを指定してください)";
  }
  return null;
}

/**
 * コマンド不在の判定。ENOENT に加え、Windows では .cmd/.bat をシェル非経由で
 * spawn できず EINVAL になる (CVE-2024-27980 対応後の Node) ため両方を対象にする。
 */
function isCommandMissing(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EINVAL";
}

let emptyFileCache: string | null = null;
function emptyFile(): string {
  if (emptyFileCache === null) {
    emptyFileCache = join(mkdtempSync(join(tmpdir(), "petari-")), "empty");
    writeFileSync(emptyFileCache, "");
  }
  return emptyFileCache;
}

export interface DiffPair {
  left: string;
  right: string;
  title: string;
}

/** 差分対象のファイルパス組を解決する (create/delete の欠損側は空ファイル) */
export function resolveDiffPair(
  root: string,
  historyDir: string,
  entry: ManifestFileEntry,
  mine: boolean,
): DiffPair | { error: string } {
  const before = join(historyDir, "before", entry.path);
  const after = join(historyDir, "after", entry.path);
  const current = join(root, entry.path);
  if (mine) {
    if (entry.op === "delete") return { error: `${entry.path} は delete のため --mine の比較対象がありません` };
    if (!existsSync(current)) return { error: `${entry.path} は現在存在しません (undo 済み?)` };
    return { left: after, right: current, title: `${entry.path} (適用直後 → 現在 = 手修正分)` };
  }
  return {
    left: existsSync(before) ? before : emptyFile(),
    right: existsSync(after) ? after : emptyFile(),
    title: `${entry.path} (before → after)`,
  };
}

/** --edit 用: スナップショット (before / --mine は after) vs 現在の実ファイル (編集対象) */
export function resolveEditPair(
  root: string,
  historyDir: string,
  entry: ManifestFileEntry,
  mine: boolean,
): DiffPair | { error: string } {
  if (entry.op === "delete") return { error: `${entry.path} は delete のため編集対象がありません` };
  const current = join(root, entry.path);
  if (!existsSync(current)) return { error: `${entry.path} は現在存在しません (undo 済み?)` };
  const snap = join(historyDir, mine ? "after" : "before", entry.path);
  return {
    left: existsSync(snap) ? snap : emptyFile(),
    right: current,
    title: `${entry.path} (${mine ? "適用直後" : "適用前"} → 現在 / 右側が編集対象)`,
  };
}

async function pickEntry(entries: ManifestFileEntry[]): Promise<ManifestFileEntry | null> {
  out("対象ファイルを選択してください:");
  entries.forEach((e, i) => out(`  ${i + 1}. ${e.op.padEnd(7)} ${e.path}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`番号 [1-${entries.length}]: `)).trim();
    const n = Number.parseInt(answer, 10);
    if (Number.isNaN(n) || n < 1 || n > entries.length) return null;
    return entries[n - 1] as ManifestFileEntry;
  } finally {
    rl.close();
  }
}

/** 履歴スナップショット/実ファイルを行テキストに読む (欠損側は空 = create/delete の片側) */
function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return decodeFile(new Uint8Array(readFileSync(path))).lines.map((l) => l.text);
}

/** 静的差分レポートの HTML を生成する (テストから直接検証できるよう export) */
export function generateReportHtml(
  root: string,
  hdir: string,
  id: string,
  entries: ManifestFileEntry[],
  mine: boolean,
): string {
  const leftLabel = mine ? "適用直後 (after)" : "適用前 (before)";
  const rightLabel = mine ? "現在のファイル" : "適用後 (after)";
  const sections: ReportFileSection[] = entries.map((e) => {
    if (mine && e.op === "delete") {
      return {
        path: e.path,
        op: e.op,
        body: { kind: "note" as const, note: "delete のため --mine の比較対象がありません" },
      };
    }
    const leftPath = join(hdir, mine ? "after" : "before", e.path);
    const rightPath = mine ? join(root, e.path) : join(hdir, "after", e.path);
    if (mine && !existsSync(rightPath)) {
      return {
        path: e.path,
        op: e.op,
        body: { kind: "note" as const, note: "現在存在しません (undo 済み?)" },
      };
    }
    try {
      const a = readLines(leftPath);
      const b = readLines(rightPath);
      return {
        path: e.path,
        op: e.op,
        body: { kind: "rows" as const, rows: toSideBySideRows(a, b, diffLines(a, b)), leftLabel, rightLabel },
      };
    } catch (cause) {
      const msg =
        cause instanceof EncodingError ? cause.message : "テキストとして表示できません";
      return { path: e.path, op: e.op, body: { kind: "note" as const, note: `差分を表示できません: ${msg}` } };
    }
  });
  const title = `petari 履歴 ${id}${mine ? " (手修正分)" : ""}`;
  return buildReportPage(title, new Date().toLocaleString("ja-JP"), sections);
}

const REPORT_DIR_PREFIX = "petari-report-";
const REPORT_TTL_MS = 60 * 60_000;

/**
 * 過去の一時レポートを掃除する (§4.3)。レポートはコードの中身を平文で含むため
 * 残し続けない。ブラウザで閲覧中かもしれない直近 1 時間分は残し、次回実行時に消す。
 * 対象は tmpdir 直下の petari-report-* ディレクトリのみ (symlink は Dirent 判定で除外)。
 */
export function cleanupOldReports(now: number = Date.now()): number {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith(REPORT_DIR_PREFIX)) continue;
    const dir = join(tmpdir(), ent.name);
    try {
      if (now - statSync(dir).mtimeMs < REPORT_TTL_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // 使用中・権限エラー等は無視 (次回実行時に再試行される)
    }
  }
  return removed;
}

/** 静的レポートを一時ファイルへ書き出してブラウザで開く */
async function runBrowserReport(
  root: string,
  hdir: string,
  id: string,
  entries: ManifestFileEntry[],
  mine: boolean,
  noOpen: boolean,
): Promise<number> {
  cleanupOldReports();
  const html = generateReportHtml(root, hdir, id, entries, mine);
  const reportPath = join(mkdtempSync(join(tmpdir(), REPORT_DIR_PREFIX)), "report.html");
  writeFileSync(reportPath, html);
  out(`差分レポートを書き出しました: ${reportPath}`);
  if (!noOpen) {
    try {
      await openInBrowser(reportPath);
    } catch {
      out("ブラウザを開けませんでした。上記のファイルを直接開いてください");
    }
  }
  return 0;
}

/** ブラウザ編集サーバーを起動し、終了 (quit ボタン / 無操作 / Ctrl+C) まで待つ */
async function runEditServer(
  root: string,
  hdir: string,
  id: string,
  entries: ManifestFileEntry[],
  mine: boolean,
  config: PetariConfig,
  noOpen: boolean,
): Promise<number> {
  if (!existsSync(join(monacoVendorDir(), "vs", "loader.js"))) {
    err("petari: ブラウザ編集用の同梱エディタ (Monaco) が見つかりません");
    err("  開発環境では pnpm gen:monaco を実行してください");
    return 1;
  }
  const sub = mine ? "after" : "before";
  const editEntries: EditEntry[] = entries.map((e) => {
    const snap = join(hdir, sub, e.path);
    return {
      path: e.path,
      absPath: join(root, e.path),
      snapshotPath: existsSync(snap) ? snap : null,
      op: e.op,
    };
  });
  const handle = await startDiffServer({
    title: `petari 履歴 ${id} の編集`,
    entries: editEntries,
    root,
    leftLabel: mine ? "適用直後 (after)" : "適用前 (before)",
    fallbackEol: config.newFile.eol,
  });
  out(`ブラウザ編集サーバーを起動しました: ${handle.url}`);
  out("  終了はページ内の「サーバーを終了」ボタンか Ctrl+C (無操作 30 分で自動終了)");
  if (!noOpen) {
    try {
      await openInBrowser(handle.url);
    } catch {
      out("ブラウザを開けませんでした。上記の URL を直接開いてください");
    }
  }
  const reason = await handle.closed;
  out(reason === "quit" ? "petari: 編集サーバーを終了しました" : "petari: 無操作のため編集サーバーを自動終了しました");
  return 0;
}

export async function showCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      mine: { type: "boolean", default: false },
      changes: { type: "boolean", default: false },
      file: { type: "string" },
      edit: { type: "boolean", default: false },
      browser: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const root = findProjectRoot(process.cwd(), values.root);
  const config = loadConfig(root);
  const noOpen = values["no-open"];

  const ids = listHistoryIds(root);
  if (ids.length === 0) {
    err("petari: 履歴がありません");
    return 1;
  }
  const id = positionals[0] ?? (ids[ids.length - 1] as string);
  const manifest = readManifest(root, id);
  if (manifest === null) {
    err(`petari: 履歴 ${id} が見つかりません (petari list で確認してください)`);
    return 1;
  }
  const hdir = join(historyRoot(root), id);

  // --changes: CHANGES セクション (概要・影響一覧・Mermaid) の表示 (§13-4)
  if (values.changes) {
    const text = readFileSync(join(hdir, "changes.md"), "utf8");
    // 寛容パースで適用した履歴の changes.md も表示できるようにする (§3.5)
    const { changeSet } = parseChangesRecovering(text);
    out(changeSet.header !== "" ? changeSet.header : "(CHANGES セクションがありません)");
    return 0;
  }

  const applied = manifest.files.filter((f) => f.applied);
  if (applied.length === 0) {
    err(`petari: 履歴 ${id} に適用済みファイルがありません`);
    return 1;
  }

  // manifest は改ざんされ得るため、対象パスを全件検証する (§9。読み取り側にも適用)
  for (const e of applied) {
    const pathReason = invalidPathReason(e.path);
    if (pathReason !== null) {
      err(`petari: manifest のパスが不正です: ${e.path} (${pathReason})`);
      return 1;
    }
  }
  // --edit は実ファイルへ書き込むため、undo と同じく symlink 経由のルート外も拒否する
  if (values.edit) {
    for (const e of applied) {
      if (!isInsideRoot(root, join(root, e.path))) {
        err(`petari: manifest のパスがプロジェクト外を指しています: ${e.path}`);
        return 1;
      }
    }
  }

  let fileEntry: ManifestFileEntry | null = null;
  if (values.file !== undefined) {
    const found = applied.find((e) => e.path === values.file);
    if (found === undefined) {
      err(`petari: ${values.file} は履歴 ${id} にありません`);
      return 1;
    }
    fileEntry = found;
  }
  const browserEntries = fileEntry !== null ? [fileEntry] : applied;

  if (!values.browser) {
    // VS Code 経路。壊れた vscodeCommand 設定はここで止める (--browser には影響させない)
    const cmdReason = invalidVscodeCommandReason(config.vscodeCommand);
    if (cmdReason !== null) {
      err(`petari: ${cmdReason}: ${config.vscodeCommand}`);
      return 1;
    }
    let entry: ManifestFileEntry;
    if (fileEntry !== null) {
      entry = fileEntry;
    } else if (applied.length === 1) {
      entry = applied[0] as ManifestFileEntry;
    } else {
      const picked = await pickEntry(applied);
      if (picked === null) {
        err("petari: 中止しました");
        return 1;
      }
      entry = picked;
    }

    const pair = values.edit
      ? resolveEditPair(root, hdir, entry, values.mine)
      : resolveDiffPair(root, hdir, entry, values.mine);
    if ("error" in pair) {
      err(`petari: ${pair.error}`);
      return 1;
    }
    out(`${config.vscodeCommand} --diff で開きます: ${pair.title}`);
    try {
      await execFileP(config.vscodeCommand, ["--diff", pair.left, pair.right]);
      return 0;
    } catch (e) {
      if (!isCommandMissing(e)) {
        err(`petari: ${config.vscodeCommand} の起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
        err("  .petari/config.json の vscodeCommand を確認してください");
        return 1;
      }
      out(`${config.vscodeCommand} が見つからないためブラウザで表示します`);
      // フォールバック: 選択済みの 1 件ではなく全ファイルをまとめて表示する
      // (レポート/編集サーバーはページ内ナビで全件を扱えるため)
    }
  }

  if (values.edit) {
    return runEditServer(root, hdir, id, browserEntries, values.mine, config, noOpen);
  }
  return runBrowserReport(root, hdir, id, browserEntries, values.mine, noOpen);
}
