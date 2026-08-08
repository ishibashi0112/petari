import type {
  FileChange,
  Operation,
  ParseIssue,
  ParseResult,
  ReplaceBlock,
} from "../types.ts";

const SEARCH = "<<<<<<< SEARCH";
const DIVIDER = "=======";
const REPLACE_END = ">>>>>>> REPLACE";
const CONTENT = "<<<<<<< CONTENT";
const CONTENT_END = ">>>>>>> END";
const CHANGES_HEADING = "## CHANGES";
const FILE_PREFIX = "### FILE:";
const FILE_RE = /^### FILE:\s*(.+?)\s*\((replace|create|rewrite|delete)\)$/;

type State = "preamble" | "header" | "fileTop" | "search" | "replace" | "content";

interface CurrentSection {
  path: string;
  op: Operation;
  line: number;
  blocks: ReplaceBlock[];
  content: string[] | null;
}

/**
 * changes.md をパースする (§3)。
 *
 * - マーカーは行頭から完全一致した行のみ (行末の空白と CR は無視)。
 *   ブロック内部ではマーカー以外のあらゆる行を原文のまま取り込む。
 * - `## CHANGES` より前の行は無視する (チャットからのコピーで前置きが混ざる想定)。
 * - 構文の問題は issues に集約する。issues が空でなければ適用してはならない。
 */
export function parseChanges(text: string): ParseResult {
  const rawLines = text.split(/\r?\n/);
  const issues: ParseIssue[] = [];
  const files: FileChange[] = [];
  const headerLines: string[] = [];
  const seenPaths = new Set<string>();

  let state: State = "preamble";
  let cur: CurrentSection | null = null;
  let searchBuf: string[] = [];
  let replaceBuf: string[] = [];
  let contentBuf: string[] = [];
  let blockLine = 0;

  // クロージャ経由の代入は TS の narrowing が追えないため、cur へのアクセスはここを通す
  function requireCur(): CurrentSection {
    if (cur === null) throw new Error("internal: FILE セクションの外でセクション参照");
    return cur;
  }

  const finishSection = (): void => {
    if (cur === null) return;
    if (cur.op === "replace") {
      if (cur.blocks.length === 0) {
        issues.push({
          line: cur.line,
          message: `${cur.path}: replace 指定ですが SEARCH/REPLACE ブロックがありません`,
        });
      }
      files.push({ op: "replace", path: cur.path, line: cur.line, blocks: cur.blocks });
    } else if (cur.op === "create" || cur.op === "rewrite") {
      if (cur.content === null) {
        issues.push({
          line: cur.line,
          message: `${cur.path}: ${cur.op} 指定ですが CONTENT ブロックがありません`,
        });
      }
      files.push({ op: cur.op, path: cur.path, line: cur.line, content: cur.content ?? [] });
    } else {
      files.push({ op: "delete", path: cur.path, line: cur.line });
    }
    cur = null;
  };

  const startSection = (path: string, op: Operation, line: number): void => {
    finishSection();
    const normalized = path.replace(/\\/g, "/");
    if (seenPaths.has(normalized)) {
      issues.push({
        line,
        message: `${normalized}: 同じファイルの FILE セクションが複数あります (1 ファイル 1 セクションに統合してください)`,
      });
    }
    seenPaths.add(normalized);
    cur = { path: normalized, op, line, blocks: [], content: null };
    state = "fileTop";
  };

  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx] ?? "";
    const line = raw.trimEnd();
    const no = idx + 1;

    if (state === "preamble") {
      if (line === CHANGES_HEADING) state = "header";
      continue;
    }

    if (state === "header" || state === "fileTop") {
      if (line.startsWith(FILE_PREFIX)) {
        const m = FILE_RE.exec(line);
        if (m !== null) {
          startSection(m[1] as string, m[2] as Operation, no);
        } else {
          issues.push({
            line: no,
            message: `FILE 行の形式が不正です (パスと操作種別 replace/create/rewrite/delete を「### FILE: path (op)」の形で指定): ${line}`,
          });
        }
        continue;
      }

      if (state === "header") {
        if (line === SEARCH || line === CONTENT || line === REPLACE_END || line === CONTENT_END) {
          issues.push({
            line: no,
            message: `${line} が最初の FILE 行より前に現れました (### FILE: 行が壊れている可能性があります)`,
          });
        } else {
          headerLines.push(raw);
        }
        continue;
      }

      // fileTop: FILE セクション内・ブロック外
      if (line === "") continue;
      const section = requireCur();
      if (section.op === "replace") {
        if (line === SEARCH) {
          state = "search";
          searchBuf = [];
          replaceBuf = [];
          blockLine = no;
        } else {
          issues.push({
            line: no,
            message: `${section.path}: SEARCH ブロックの外に予期しない行があります: ${line}`,
          });
        }
      } else if (section.op === "create" || section.op === "rewrite") {
        if (line === CONTENT) {
          if (section.content !== null) {
            issues.push({
              line: no,
              message: `${section.path}: CONTENT ブロックが複数あります (全文を 1 ブロックにまとめてください)`,
            });
          }
          state = "content";
          contentBuf = [];
          blockLine = no;
        } else {
          issues.push({
            line: no,
            message: `${section.path}: CONTENT ブロックの外に予期しない行があります: ${line}`,
          });
        }
      } else {
        // delete
        issues.push({
          line: no,
          message: `${section.path}: delete 指定に本文は書けません: ${line}`,
        });
      }
      continue;
    }

    if (state === "search") {
      if (line === DIVIDER) {
        state = "replace";
      } else if (line === REPLACE_END) {
        issues.push({
          line: no,
          message: `${requireCur().path}: ======= (区切り) がないまま >>>>>>> REPLACE が現れました`,
        });
        state = "fileTop";
      } else if (line === SEARCH) {
        issues.push({
          line: no,
          message: `${requireCur().path}: SEARCH ブロックが閉じられないまま次の <<<<<<< SEARCH が現れました`,
        });
        searchBuf = [];
        blockLine = no;
      } else {
        searchBuf.push(raw);
      }
      continue;
    }

    if (state === "replace") {
      const section = requireCur();
      if (line === REPLACE_END) {
        if (searchBuf.length === 0) {
          issues.push({ line: blockLine, message: `${section.path}: SEARCH ブロックが空です` });
        }
        section.blocks.push({
          search: searchBuf,
          replace: replaceBuf,
          line: blockLine,
          index: section.blocks.length + 1,
        });
        state = "fileTop";
      } else if (line === DIVIDER) {
        issues.push({
          line: no,
          message: `${section.path}: ======= (区切り) が 1 ブロック内に複数あります`,
        });
        state = "fileTop";
      } else if (line === SEARCH) {
        issues.push({
          line: no,
          message: `${section.path}: >>>>>>> REPLACE で閉じられないまま次の <<<<<<< SEARCH が現れました`,
        });
        searchBuf = [];
        replaceBuf = [];
        blockLine = no;
        state = "search";
      } else {
        replaceBuf.push(raw);
      }
      continue;
    }

    // state === "content"
    if (line === CONTENT_END) {
      requireCur().content = contentBuf;
      state = "fileTop";
    } else {
      contentBuf.push(raw);
    }
  }

  // EOF
  if (state === "preamble") {
    issues.push({ line: 1, message: `${CHANGES_HEADING} セクションがありません` });
  }
  if (state === "search" || state === "replace") {
    issues.push({
      line: blockLine,
      message: `${requireCur().path}: SEARCH/REPLACE ブロックが >>>>>>> REPLACE で閉じられていません`,
    });
  }
  if (state === "content") {
    issues.push({
      line: blockLine,
      message: `${requireCur().path}: CONTENT ブロックが >>>>>>> END で閉じられていません`,
    });
  }
  finishSection();

  const header = headerLines.join("\n").trim();
  if (state !== "preamble" && header === "") {
    issues.push({ line: 1, message: "変更概要 (CHANGES セクション本文) が空です" });
  }
  if (state !== "preamble" && files.length === 0) {
    issues.push({ line: 1, message: "FILE セクションが 1 つもありません" });
  }

  return { changeSet: { header, files }, issues };
}
