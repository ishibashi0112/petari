/**
 * ChangeSet の検証と適用計画 (§4.1 手順 1-3, §9)。
 * I/O を持たない純粋層: ファイル状態 (FileState) を受け取り、
 * 書き込むべきバイト列と失敗一覧を返す。実際の読み書きは commands/ が行う。
 */
import type { ChangeSet, FileChange, ReplaceBlock } from "../types.ts";
import {
  EncodingError,
  decodeFile,
  encodeDocument,
  findUnencodable,
  makeDocument,
  type DocLine,
  type Eol,
  type FileEncoding,
} from "./encoding.ts";
import { STAGE_LABEL, matchBlock, type MatchStage } from "./matcher.ts";

export interface NewFileConfig {
  encoding: FileEncoding;
  bom?: boolean;
  eol: Eol;
}

/** 適用前のファイル状態 (commands 層が lstat / read して渡す) */
export interface FileState {
  exists: boolean;
  symlink: boolean;
  bytes: Uint8Array | null;
  /** パスが symlink ディレクトリ経由でプロジェクトルートの外を指している (§9) */
  escapesRoot?: boolean;
}

export type FailureKind =
  | "path-invalid"
  | "symlink"
  | "target-missing"
  | "target-exists"
  | "undecodable"
  | "block-not-found"
  | "block-ambiguous"
  | "unencodable";

export interface Failure {
  path: string;
  kind: FailureKind;
  message: string;
  /** ブロック起因の失敗のとき、そのブロック */
  block?: ReplaceBlock;
}

/** 適用に成功した replace ブロックの記録 (差分プレビューと manifest 用) */
export interface AppliedBlockInfo {
  block: ReplaceBlock;
  stage: MatchStage;
  /** 適用直前の行配列に対するマッチ開始位置 (0-based) */
  start: number;
  removed: string[];
  inserted: string[];
}

export interface FileOutcome {
  change: FileChange;
  failures: Failure[];
  /** 書き込むバイト列。delete と「書き込み不要 (失敗/全ブロック失敗)」は null */
  afterBytes: Uint8Array | null;
  appliedBlocks: AppliedBlockInfo[];
  totalBlocks: number;
}

export interface Plan {
  outcomes: FileOutcome[];
  /** 全ファイルの失敗を平坦化したもの */
  failures: Failure[];
  /** 失敗ゼロなら true (all-or-nothing 判定・§4.1) */
  ok: boolean;
}

/** Windows の予約デバイス名 (拡張子付きも不可) */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..+)?$/i;

/** §9: プロジェクトルート相対のみ。絶対パス・`..`・`~`・Windows 特殊パスを拒否 */
export function invalidPathReason(path: string): string | null {
  if (path.trim() === "") return "パスが空です";
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:/.test(path)) {
    return "絶対パスは使えません (プロジェクトルート相対で指定してください)";
  }
  if (path.includes(":")) return "':' を含むパスは使えません (Windows の代替データストリーム対策)";
  const segments = path.split("/");
  if (segments.includes("..")) return "'..' を含むパスは使えません";
  if (path.startsWith("~")) return "'~' で始まるパスは使えません";
  if (segments.some((s) => WINDOWS_RESERVED.test(s))) {
    return "Windows の予約デバイス名 (CON, NUL, COM1 等) を含むパスは使えません";
  }
  return null;
}

function fileFailure(change: FileChange, kind: FailureKind, message: string): FileOutcome {
  return {
    change,
    failures: [{ path: change.path, kind, message }],
    afterBytes: null,
    appliedBlocks: [],
    totalBlocks: change.op === "replace" ? change.blocks.length : 0,
  };
}

function planReplace(
  change: FileChange & { op: "replace" },
  state: FileState,
  fallbackEol: Eol,
): FileOutcome {
  let doc;
  try {
    doc = decodeFile(state.bytes as Uint8Array);
  } catch (e) {
    return fileFailure(
      change,
      "undecodable",
      e instanceof EncodingError ? e.message : String(e),
    );
  }

  const failures: Failure[] = [];
  const applied: AppliedBlockInfo[] = [];
  let docLines: DocLine[] = doc.lines;
  let textLines: string[] = docLines.map((l) => l.text);

  for (const block of change.blocks) {
    const m = matchBlock(textLines, block);
    if (!m.ok) {
      const message =
        m.reason === "ambiguous"
          ? `ブロック ${block.index}: SEARCH が ${m.count} 箇所にマッチしました (${STAGE_LABEL[m.stage as MatchStage]})。一意に特定できる範囲を含めてください`
          : `ブロック ${block.index}: SEARCH が現在のファイル内容に見つかりません`;
      failures.push({ path: change.path, kind: m.reason === "ambiguous" ? "block-ambiguous" : "block-not-found", message, block });
      continue;
    }
    const replacement = m.replacement as string[];
    const bad = findUnencodable(replacement.join("\n"), doc.encoding);
    if (bad.length > 0) {
      failures.push({
        path: change.path,
        kind: "unencodable",
        message: `ブロック ${block.index}: REPLACE 側に Shift_JIS へ変換できない文字が含まれています: ${bad.join(" ")}`,
        block,
      });
      continue;
    }
    applied.push({
      block,
      stage: m.stage,
      start: m.start,
      removed: textLines.slice(m.start, m.end),
      inserted: replacement,
    });
    const newDocLines: DocLine[] = replacement.map((text) => ({ text, raw: null, eol: null }));
    docLines = [...docLines.slice(0, m.start), ...newDocLines, ...docLines.slice(m.end)];
    textLines = [...textLines.slice(0, m.start), ...replacement, ...textLines.slice(m.end)];
  }

  const afterBytes =
    applied.length > 0 ? encodeDocument({ ...doc, lines: docLines }, fallbackEol) : null;
  return {
    change,
    failures,
    afterBytes,
    appliedBlocks: applied,
    totalBlocks: change.blocks.length,
  };
}

function planFile(change: FileChange, state: FileState, newFile: NewFileConfig): FileOutcome {
  const pathReason = invalidPathReason(change.path);
  if (pathReason !== null) return fileFailure(change, "path-invalid", pathReason);
  if (state.escapesRoot === true) {
    return fileFailure(
      change,
      "path-invalid",
      "シンボリックリンクを経由してプロジェクトルートの外を指しています (§9)",
    );
  }
  if (state.symlink) {
    return fileFailure(change, "symlink", "シンボリックリンクは書き換え対象外です (§9)");
  }

  switch (change.op) {
    case "create": {
      if (state.exists) {
        return fileFailure(change, "target-exists", "create 指定ですがファイルが既に存在します (全文置き換えなら rewrite を使用)");
      }
      const bad = findUnencodable(change.content.join("\n"), newFile.encoding);
      if (bad.length > 0) {
        return fileFailure(change, "unencodable", `新規ファイルの既定エンコーディング (${newFile.encoding}) に変換できない文字: ${bad.join(" ")}`);
      }
      const doc = makeDocument(change.content, newFile);
      return { change, failures: [], afterBytes: encodeDocument(doc), appliedBlocks: [], totalBlocks: 0 };
    }
    case "rewrite": {
      if (!state.exists) {
        return fileFailure(change, "target-missing", "rewrite 指定ですがファイルが存在しません (新規作成なら create を使用)");
      }
      let doc;
      try {
        doc = decodeFile(state.bytes as Uint8Array);
      } catch (e) {
        return fileFailure(change, "undecodable", e instanceof EncodingError ? e.message : String(e));
      }
      const bad = findUnencodable(change.content.join("\n"), doc.encoding);
      if (bad.length > 0) {
        return fileFailure(change, "unencodable", `Shift_JIS へ変換できない文字が含まれています: ${bad.join(" ")}`);
      }
      // 既存のエンコーディング・BOM・支配的 EOL・末尾改行の有無を維持して全文を差し替える (§8)
      const lines: DocLine[] = change.content.map((text) => ({ text, raw: null, eol: null }));
      const afterBytes = encodeDocument({ ...doc, lines });
      return { change, failures: [], afterBytes, appliedBlocks: [], totalBlocks: 0 };
    }
    case "delete": {
      if (!state.exists) {
        return fileFailure(change, "target-missing", "delete 指定ですがファイルが存在しません");
      }
      return { change, failures: [], afterBytes: null, appliedBlocks: [], totalBlocks: 0 };
    }
    case "replace": {
      if (!state.exists) {
        return fileFailure(change, "target-missing", "replace 指定ですがファイルが存在しません");
      }
      return planReplace(change, state, newFile.eol);
    }
  }
}

/** 全ファイルをドライラン検証し適用計画を立てる (§4.1 手順 2)。書き込みは行わない */
export function planChangeSet(
  changeSet: ChangeSet,
  states: Map<string, FileState>,
  newFile: NewFileConfig,
): Plan {
  const outcomes = changeSet.files.map((change) => {
    const state = states.get(change.path) ?? { exists: false, symlink: false, bytes: null };
    return planFile(change, state, newFile);
  });
  const failures = outcomes.flatMap((o) => o.failures);
  return { outcomes, failures, ok: failures.length === 0 };
}
