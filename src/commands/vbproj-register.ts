/**
 * create した .vb の旧スタイル .vbproj への自動登録 (設計書 §11.1 P1-a) — apply の結線部。
 * 判定・挿入は core/vbproj.ts、探索は infra/vbproj.ts。
 *
 * - 登録の失敗は create 自体の成否に影響しない (レポートに載せるだけ)
 * - 同じ changes.md が .vbproj 自体を変更する場合は、その変更後の内容に対して登録する
 * - 挿入行以外は元バイト列を書き戻す (行単位ドキュメント・§8)
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { FileOutcome } from "../core/applier.ts";
import {
  EncodingError,
  decodeFile,
  encodeDocument,
  findUnencodable,
  type DocLine,
  type FileDocument,
} from "../core/encoding.ts";
import {
  designerParentName,
  detectSubType,
  registerCompileItem,
  toIncludePath,
} from "../core/vbproj.ts";
import { isInsideRoot, readFileState } from "../infra/files.ts";
import { findNearestVbproj } from "../infra/vbproj.ts";

export interface VbprojRegistration {
  /** ルート相対の .vbproj パス */
  vbproj: string;
  /** 登録した .vb (ルート相対) */
  file: string;
  include: string;
  subType?: string;
  dependentUpon?: string;
}

/** 登録しなかった理由 (未登録 / 登録不要 / 登録済み)。失敗ではない */
export interface VbprojNote {
  file: string;
  message: string;
}

export interface VbprojWrite {
  /** 登録前のバイト列 (changes.md の変更対象でもある場合はその変更後の内容) */
  before: Uint8Array | null;
  after: Uint8Array;
  registered: string[];
}

export interface VbprojPlan {
  /** 書き込む .vbproj (ルート相対パス → 内容) */
  writes: Map<string, VbprojWrite>;
  registrations: VbprojRegistration[];
  notes: VbprojNote[];
}

interface LoadedVbproj {
  doc: FileDocument;
  lines: DocLine[];
  before: Uint8Array | null;
  registered: string[];
}

const EMPTY: VbprojPlan = { writes: new Map(), registrations: [], notes: [] };

function relDirOf(path: string): string {
  const d = dirname(path);
  return d === "." ? "" : d;
}

/**
 * 書き込み対象 (applicable) の outcomes から create された .vb を拾い、登録計画を立てる。
 * 書き込みは行わない。
 */
export function planVbprojRegistrations(root: string, applicable: FileOutcome[]): VbprojPlan {
  const creates = applicable
    .filter((o) => o.change.op === "create" && /\.vb$/i.test(o.change.path))
    // X.vb を X.Designer.vb より先に登録する (VS の並びに合わせる。安定ソート)
    .map((o, i) => ({ o, i, designer: designerParentName(basename(o.change.path)) !== null }))
    .sort((a, b) => Number(a.designer) - Number(b.designer) || a.i - b.i)
    .map((x) => x.o);
  if (creates.length === 0) return EMPTY;

  const createdPaths = new Set(
    applicable.filter((o) => o.change.op === "create").map((o) => o.change.path.toLowerCase()),
  );
  const loaded = new Map<string, LoadedVbproj | { error: string }>();
  const plan: VbprojPlan = { writes: new Map(), registrations: [], notes: [] };

  const load = (vbproj: string): LoadedVbproj | { error: string } => {
    const cached = loaded.get(vbproj);
    if (cached !== undefined) return cached;
    const result = loadVbproj(root, vbproj, applicable);
    loaded.set(vbproj, result);
    return result;
  };

  for (const o of creates) {
    const file = o.change.path;
    const lookup = findNearestVbproj(root, relDirOf(file));
    if (lookup.kind === "none") {
      plan.notes.push({ file, message: "vbproj が見つからないため未登録" });
      continue;
    }
    if (lookup.kind === "multiple") {
      plan.notes.push({
        file,
        message: `${lookup.dir} に複数の .vbproj があるため未登録 (${lookup.names.join(", ")})。手動で登録してください`,
      });
      continue;
    }
    const target = load(lookup.path);
    if ("error" in target) {
      plan.notes.push({ file, message: `${lookup.path} に未登録 (${target.error})` });
      continue;
    }

    const include = toIncludePath(relDirOf(lookup.path), file);
    const parent = designerParentName(basename(file));
    const opts: { subType?: string; dependentUpon?: string } = {};
    if (parent !== null) {
      // 親が同じ changes.md で create されるか、既にディスクにあれば DependentUpon を付ける
      const parentPath = relDirOf(file) === "" ? parent : `${relDirOf(file)}/${parent}`;
      if (createdPaths.has(parentPath.toLowerCase()) || existsSync(join(root, parentPath))) {
        opts.dependentUpon = parent;
      }
    } else if (o.change.op === "create") {
      const subType = detectSubType(o.change.content);
      if (subType !== undefined) opts.subType = subType;
    }

    const r = registerCompileItem(
      target.lines.map((l) => l.text),
      include,
      opts,
    );
    if (r.status === "registered") {
      plan.notes.push({ file, message: `${lookup.path} に登録済み (変更なし)` });
      continue;
    }
    if (r.status === "sdk-style") {
      plan.notes.push({ file, message: `${lookup.path} は SDK スタイルのため登録不要` });
      continue;
    }
    if (r.status === "unsupported") {
      plan.notes.push({
        file,
        message: `${lookup.path} は登録できない形式のため未登録 (${r.reason})。手動で登録してください`,
      });
      continue;
    }
    const bad = findUnencodable(r.inserted.join("\n"), target.doc.encoding);
    if (bad.length > 0) {
      plan.notes.push({
        file,
        message: `${lookup.path} (Shift_JIS) に変換できない文字がパスに含まれるため未登録: ${bad.join(" ")}`,
      });
      continue;
    }
    const inserted: DocLine[] = r.inserted.map((text) => ({ text, raw: null, eol: null }));
    target.lines = [...target.lines.slice(0, r.at), ...inserted, ...target.lines.slice(r.at)];
    target.registered.push(file);
    plan.registrations.push({ vbproj: lookup.path, file, include, ...opts });
  }

  for (const [vbproj, t] of loaded) {
    if ("error" in t || t.registered.length === 0) continue;
    plan.writes.set(vbproj, {
      before: t.before,
      after: encodeDocument({ ...t.doc, lines: t.lines }),
      registered: t.registered,
    });
  }
  return plan;
}

/** .vbproj の現在の内容 (changes.md が同じ .vbproj を変更するならその変更後) を読む */
function loadVbproj(
  root: string,
  vbproj: string,
  applicable: FileOutcome[],
): LoadedVbproj | { error: string } {
  const own = applicable.find((o) => o.change.path === vbproj);
  let bytes: Uint8Array | null;
  if (own !== undefined) {
    if (own.change.op === "delete") return { error: "changes.md がこの .vbproj を削除するため" };
    bytes = own.afterBytes;
  } else {
    const abs = join(root, vbproj);
    if (!isInsideRoot(root, abs)) return { error: "プロジェクトルートの外を指しているため" };
    const state = readFileState(abs);
    if (state.symlink) return { error: "シンボリックリンクのため" };
    bytes = state.bytes;
  }
  if (bytes === null) return { error: "内容を読めないため" };
  try {
    const doc = decodeFile(bytes);
    return { doc, lines: doc.lines, before: bytes, registered: [] };
  } catch (e) {
    return { error: e instanceof EncodingError ? e.message : String(e) };
  }
}

/** 端末表示 (プレビュー・確認・サマリ共通)。該当がなければ何も出さない */
export function formatVbprojPlan(plan: VbprojPlan): string[] {
  const lines: string[] = [];
  for (const r of plan.registrations) {
    const extra = [
      r.subType !== undefined ? `SubType: ${r.subType}` : null,
      r.dependentUpon !== undefined ? `DependentUpon: ${r.dependentUpon}` : null,
    ].filter((x) => x !== null);
    lines.push(
      `  vbproj に登録: ${r.vbproj} ← ${r.file}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`,
    );
  }
  for (const n of plan.notes) lines.push(`  vbproj: ${n.file} — ${n.message}`);
  return lines;
}
