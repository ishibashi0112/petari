/** changes.md の操作種別 (§3.2) */
export type Operation = "replace" | "create" | "rewrite" | "delete";

/** search/replace ブロック 1 個。行配列は changes.md の原文そのまま (改行なし) */
export interface ReplaceBlock {
  search: string[];
  replace: string[];
  /** changes.md 内の <<<<<<< SEARCH の行番号 (1-based) */
  line: number;
  /** 同一ファイル内で何番目のブロックか (1-based) */
  index: number;
}

interface BaseFileChange {
  /** プロジェクトルート相対パス (区切りは / に正規化済み) */
  path: string;
  /** changes.md 内の ### FILE: 行の行番号 (1-based) */
  line: number;
}

export interface ReplaceFileChange extends BaseFileChange {
  op: "replace";
  blocks: ReplaceBlock[];
}

export interface CreateFileChange extends BaseFileChange {
  op: "create";
  content: string[];
}

export interface RewriteFileChange extends BaseFileChange {
  op: "rewrite";
  content: string[];
}

export interface DeleteFileChange extends BaseFileChange {
  op: "delete";
}

export type FileChange =
  | ReplaceFileChange
  | CreateFileChange
  | RewriteFileChange
  | DeleteFileChange;

/** パース結果 */
export interface ChangeSet {
  /** ## CHANGES 直後〜最初の ### FILE: までの本文 (外側の空行のみ除去) */
  header: string;
  files: FileChange[];
}

export interface ParseIssue {
  /** changes.md 内の行番号 (1-based) */
  line: number;
  message: string;
}

export interface ParseResult {
  changeSet: ChangeSet;
  issues: ParseIssue[];
}

/** 寛容パース (§3.5) の結果。repairs が空でなければ lenient 解釈が採用されている */
export interface RecoveredParseResult extends ParseResult {
  /** 自動補正した内容 (行番号 + 補正説明)。strict で成功した場合は空 */
  repairs: ParseIssue[];
}
