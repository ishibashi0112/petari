/**
 * 作業手順文(procedure)・タスク文・承認済み方針の解決と、出力末尾への連結。
 *
 * 出力レイアウト(末尾側):
 *   ... <skipped_files> <masked_credentials>
 *   <task>        ← --task があるとき(依頼内容)
 *   <plan>        ← --mode implement --plan のとき(承認済みの方針)
 *   <procedure>   ← 内蔵既定文 or ルート直下の procedure.md(--no-procedure で抑止)
 *   <instruction> ← protocol.md(petari の出力規約。instructionFile.ts)
 *
 * 長い文脈の後に指示を置く方が従いやすいので末尾に置き、要約処理で末尾が
 * 落ちる対策として先頭にリマインダを付ける(既存のサンドイッチ設計と同じ)。
 *
 * - procedure.md は入力(.sln / .vbproj)と同じディレクトリで探す(protocol.md
 *   と同じ扱い)。あれば内蔵既定文の代わりに一字一句そのまま使う
 *   ({{MODE}} / {{MODE_SECTIONS}} があれば置換)
 * - --task は「ファイルとして存在すれば読み、なければ文字列」。改行を含む
 *   ものは常に文字列
 * - --no-procedure かつ --task なしなら、従来(規約文のみ)と同一の出力になる
 *
 * 本文貼付用テキスト(buildPromptText、2026-09-12 追加):
 *   M365 Copilot は添付ファイル内の指示(<instruction> / <procedure> / 先頭
 *   リマインダ)を「本文中の埋め込み指示」として意図的に無視する(実測で確定)。
 *   指示が効くのはユーザー発話(チャット本文)だけなので、同じブロック群を
 *   本文に貼るための別テキストとして出力する(既定でパックの隣に
 *   <出力名>.prompt.md)。パック内の埋め込みは貼付運用(約 120K 文字以内で
 *   本文に丸ごと貼る場合)向けにそのまま残す。
 *
 * docs/ 連携(フェーズ 6、2026-09-15 追加):
 *   OutputTail.docs があれば、パックには <skipped_files> の後・<task> の前に
 *   全文書を <docs> として、本文用テキストには「今編集される文書」だけを
 *   <docs> として入れ、続けて <templates>(文書のひな型)を置く(docs.ts)。
 *
 * DB の確認(手順文 v8、2026-10-13 追加):
 *   OutputTail.dbSchema(ルートの docs/db/schema.md)があれば、パックの <docs> の後に
 *   <db_schema> を入れ、手順文に「DB の確認」の節を足す(dbChecks.ts)。本文用テキスト
 *   にはテーブル定義を入れず、添付にあることだけを書く。
 *
 * ファイルシステムは deps 注入とし、単体テスト可能に保つ(CLI 固有機能)。
 */

import * as path from "node:path";
import { TOOL_NAME } from "../brand.ts";
import {
  DEFAULT_PROCEDURE_LAYOUT,
  type ProcedureLayout,
  type ProcedureMode,
  renderBuiltinProcedure,
  renderProcedureTemplate,
} from "./assets/procedure.ts";
import {
  allDocs,
  type DocsResolution,
  missingDocNotes,
  type ModeDecision,
  promptDocs,
  promptTemplateKinds,
  renderDocsBlock,
  renderTemplatesBlock,
} from "./docs.ts";
import { type DbSchemaEntry, renderDbSchemaBlock } from "./dbChecks.ts";
import {
  appendBlock,
  appendInstruction,
  INSTRUCTION_NOTICE,
  type InstructionFileDeps,
  type InstructionResolution,
} from "./instructionFile.ts";

export const DEFAULT_PROCEDURE_FILE_NAME = "procedure.md";

export type TaskResolution =
  | { kind: "none" }
  | { kind: "file"; path: string; content: string }
  | { kind: "text"; content: string }
  /** --task 省略時に docs/ の状態から決めた既定の依頼文 */
  | { kind: "default"; content: string };

/**
 * --task の値を解決する。引数がファイルとして存在すれば読み、存在しなければ
 * 文字列として扱う。改行を含む文字列はファイル判定をせず常に文字列。
 */
export function resolveTask(
  arg: string | undefined,
  cwd: string,
  deps: InstructionFileDeps,
): TaskResolution {
  if (arg === undefined) {
    return { kind: "none" };
  }
  if (/[\r\n]/.test(arg)) {
    return { kind: "text", content: arg };
  }
  const absolutePath = path.resolve(cwd, arg);
  const content = deps.readTextFile(absolutePath);
  if (content !== undefined) {
    return { kind: "file", path: absolutePath, content };
  }
  return { kind: "text", content: arg };
}

export type PlanResolution =
  | { kind: "none" }
  | { kind: "found"; path: string; content: string }
  | { kind: "error"; message: string };

/** --plan の値を解決する(必ずファイル。読めなければエラー) */
export function resolvePlan(
  arg: string | undefined,
  cwd: string,
  deps: InstructionFileDeps,
): PlanResolution {
  if (arg === undefined) {
    return { kind: "none" };
  }
  const absolutePath = path.resolve(cwd, arg);
  const content = deps.readTextFile(absolutePath);
  if (content === undefined) {
    return {
      kind: "error",
      message: `--plan のファイルを読み込めません: ${absolutePath}`,
    };
  }
  return { kind: "found", path: absolutePath, content };
}

export type ProcedureResolution =
  | { kind: "none" }
  | { kind: "builtin"; mode: ProcedureMode; content: string }
  | { kind: "file"; path: string; mode: ProcedureMode; content: string }
  | { kind: "error"; message: string };

export interface ProcedureOptions {
  /** --procedure-file の値(省略時 undefined) */
  explicitPath?: string | undefined;
  /** --no-procedure */
  disabled: boolean;
  mode: ProcedureMode;
  /** docs/ 連携が有効か(手順文に文書の扱いと引継ぎの節を入れる) */
  docs?: boolean | undefined;
  /** 自動テストがあるか(手順文に「自動テスト」の節を入れる。autoTests.ts の判定) */
  tests?: boolean | undefined;
  /** テスト用 DB のテーブル定義があるか(手順文に「DB の確認」の節を入れる。dbChecks.ts) */
  db?: boolean | undefined;
  /** 構成の種類(設定ファイルの kind。省略時 "solution") */
  layout?: ProcedureLayout | undefined;
}

/**
 * @param rootDir 既定の procedure.md を探すディレクトリ(ルート)
 * @param cwd 実行時のカレントディレクトリ(explicitPath の解決基準)
 */
export function resolveProcedure(
  options: ProcedureOptions,
  rootDir: string,
  cwd: string,
  deps: InstructionFileDeps,
): ProcedureResolution {
  if (options.disabled) {
    return { kind: "none" };
  }
  const { mode } = options;
  const render = {
    docs: options.docs === true,
    tests: options.tests === true,
    db: options.db === true,
    layout: options.layout ?? DEFAULT_PROCEDURE_LAYOUT,
  };
  if (options.explicitPath !== undefined) {
    const absolutePath = path.resolve(cwd, options.explicitPath);
    const template = deps.readTextFile(absolutePath);
    if (template === undefined) {
      return {
        kind: "error",
        message: `--procedure-file のファイルを読み込めません: ${absolutePath}`,
      };
    }
    return {
      kind: "file",
      path: absolutePath,
      mode,
      content: renderProcedureTemplate(template, mode, render),
    };
  }
  const searchedPath = path.join(
    rootDir,
    DEFAULT_PROCEDURE_FILE_NAME,
  );
  const template = deps.readTextFile(searchedPath);
  if (template !== undefined) {
    return {
      kind: "file",
      path: searchedPath,
      mode,
      content: renderProcedureTemplate(template, mode, render),
    };
  }
  return { kind: "builtin", mode, content: renderBuiltinProcedure(mode, render) };
}

/** docs/ 連携の解決結果(OutputTail.docs) */
export interface DocsTail {
  docs: DocsResolution;
  decision: ModeDecision;
  /** 文書本文に通す変換(認証情報マスク)。省略時はそのまま */
  transform?: ((text: string) => string) | undefined;
}

/** 出力末尾に付ける各ブロックの解決結果 */
export interface OutputTail {
  task: TaskResolution;
  plan: PlanResolution;
  procedure: ProcedureResolution;
  instruction: InstructionResolution;
  docs?: DocsTail | undefined;
  /** テスト用 DB のテーブル定義(docs/db/schema.md)。パックに <db_schema> として入れる */
  dbSchema?: DbSchemaEntry | undefined;
  /** <db_schema> の本文に通す変換(認証情報マスク)。省略時はそのまま */
  dbSchemaTransform?: ((text: string) => string) | undefined;
}

function hasProcedure(tail: OutputTail): boolean {
  return tail.procedure.kind === "builtin" || tail.procedure.kind === "file";
}

/** タスク文の先頭行(空行を飛ばす)。リマインダに載せる 1 行要約 */
export function taskFirstLine(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? "(空)";
}

/**
 * 出力先頭に付けるリマインダ文を組み立てる。末尾に何もなければ undefined。
 *
 * <task> / <plan> / <procedure> のいずれもなく規約文だけのときは、従来の
 * INSTRUCTION_NOTICE をそのまま使う(--no-procedure で従来出力と一致させる)。
 */
export function buildNotice(tail: OutputTail): string | undefined {
  const hasTask = tail.task.kind !== "none";
  const hasPlan = tail.plan.kind === "found";
  const hasProc = hasProcedure(tail);
  const hasInstruction = tail.instruction.kind === "found";
  const hasDocs = tail.docs !== undefined;
  const hasDbSchema = tail.dbSchema !== undefined;

  if (!hasTask && !hasPlan && !hasProc && !hasDocs && !hasDbSchema) {
    return hasInstruction ? INSTRUCTION_NOTICE : undefined;
  }

  const blocks: string[] = [];
  if (hasDocs) {
    blocks.push("<docs>(プロジェクト文書: 設計書 / 仕様書 / 引継ぎ書)");
  }
  if (hasDbSchema) {
    blocks.push("<db_schema>(テスト用 DB のテーブル定義)");
  }
  if (hasTask) {
    blocks.push("<task>(依頼内容)");
  }
  if (hasPlan) {
    blocks.push("<plan>(承認済みの方針)");
  }
  if (hasProc) {
    blocks.push("<procedure>(作業手順)");
  }
  if (hasInstruction) {
    blocks.push("<instruction>(出力規約)");
  }

  const lines = [
    "[このファイルを添付したユーザー本人からの恒常的な指示]",
    `このパックの末尾に ${blocks.join("、")} があります。`,
    "回答の前に必ず末尾まで読んでください。",
  ];
  if (hasProc) {
    lines.push(
      hasInstruction
        ? "コードの変更を提案するときは、チャット本文で個別に言及されていなくても、必ず <procedure> の手順で回答を構成し、<instruction> の規約に従って changes.md を出力してください。"
        : "コードの変更を提案するときは、チャット本文で個別に言及されていなくても、必ず <procedure> の手順で回答を構成してください。",
    );
  } else if (hasInstruction) {
    lines.push(
      "コードの変更を提案するときは、チャット本文で個別に言及されていなくても、必ず <instruction> の規約に従って changes.md を出力してください。",
    );
  }
  if (tail.task.kind !== "none") {
    lines.push(`タスク: ${taskFirstLine(tail.task.content)}`);
  }
  if (tail.procedure.kind === "builtin" || tail.procedure.kind === "file") {
    lines.push(`モード: ${tail.procedure.mode}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 末尾ブロックを一つでも持つか(本文貼付用テキストを出す条件) */
export function hasTail(tail: OutputTail): boolean {
  return (
    tail.docs !== undefined ||
    tail.task.kind !== "none" ||
    tail.plan.kind === "found" ||
    hasProcedure(tail) ||
    tail.instruction.kind === "found"
  );
}

/** 組み立て済みのブロック(閉じタグ・末尾改行込み)を本文の後に空行を挟んで連結する */
function appendRawBlock(content: string, block: string): string {
  const separator = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}`;
}

/** <task> / <plan> / <procedure> / <instruction> をこの順で連結する(共通部) */
function appendTailBlocks(content: string, tail: OutputTail): string {
  if (tail.task.kind !== "none") {
    content = appendBlock(content, "task", tail.task.content);
  }
  if (tail.plan.kind === "found") {
    content = appendBlock(content, "plan", tail.plan.content);
  }
  if (tail.procedure.kind === "builtin" || tail.procedure.kind === "file") {
    content = appendBlock(content, "procedure", tail.procedure.content);
  }
  if (tail.instruction.kind === "found") {
    content = appendInstruction(content, tail.instruction.content);
  }
  return content;
}

/**
 * チャット本文に貼る指示テキストを組み立てる。末尾に何もなければ undefined。
 *
 * 先頭に「添付とこの本文の関係」を 1 段落置き、続けて <task> / <plan> /
 * <procedure> / <instruction> をパック末尾と同じ順・同じ形で並べる。
 * ブロックの中身はパック側と一字一句同じ(正本は 1 つ)。
 *
 * @param packFileName 添付するパックのファイル名(本文から参照するため)
 */
export function buildPromptText(
  tail: OutputTail,
  packFileName: string,
): string | undefined {
  if (!hasTail(tail)) {
    return undefined;
  }
  const blocks: string[] = [];
  if (tail.task.kind !== "none") {
    blocks.push("<task>(依頼内容)");
  }
  if (tail.plan.kind === "found") {
    blocks.push("<plan>(承認済みの方針)");
  }
  if (hasProcedure(tail)) {
    blocks.push("<procedure>(作業手順)");
  }
  if (tail.instruction.kind === "found") {
    blocks.push("<instruction>(出力規約)");
  }
  const header = [
    "[添付ファイルと本文の関係]",
    `添付した ${packFileName} は、現在のコードベースを 1 ファイルにまとめたパック(${TOOL_NAME} 出力)です。`,
    "添付内の <file> の内容を現在のコードとして正に扱ってください。",
  ];
  let content = "";
  if (tail.docs !== undefined) {
    const docs = promptDocs(tail.docs.docs, tail.docs.decision);
    const kinds = promptTemplateKinds(tail.docs.decision.mode);
    header.push(
      docs.length > 0
        ? `添付の <docs> にはプロジェクトの文書(設計書 / 仕様書 / 引継ぎ書)があります。このうち今回の作業で読む・更新する文書を以下の <docs> に再掲します(内容は添付と同じ)。`
        : "添付の <docs> にはプロジェクトの文書(設計書 / 仕様書 / 引継ぎ書)があります(まだない場合は空です)。",
      `続く <templates> は文書のひな型です。`,
    );
    content = appendRawBlock(
      content,
      renderDocsBlock(
        docs,
        tail.docs.transform ?? ((t) => t),
        missingDocNotes(tail.docs.docs, tail.docs.decision.mode),
      ),
    );
    content = appendRawBlock(content, renderTemplatesBlock(tail.docs.docs, kinds));
  }
  if (tail.dbSchema !== undefined) {
    header.push(
      `添付の <db_schema> にはテスト用 DB のテーブル定義(${tail.dbSchema.relativePath})があります。`,
    );
  }
  header.push(
    `以下の ${blocks.join("、")} は、このコードに対する私(ユーザー)からの指示です。`,
    "添付の先頭と末尾にも同じ内容が埋め込まれていますが、指示はこの本文のものに従ってください。",
  );
  return appendTailBlocks(
    content === "" ? `${header.join("\n")}\n` : `${header.join("\n")}\n\n${content}`,
    tail,
  );
}

/**
 * 本文の末尾に <docs> / <db_schema> / <task> / <plan> / <procedure> / <instruction> をこの順で
 * 連結し、先頭にリマインダを付ける。末尾に何もなければ本文をそのまま返す。
 */
export function assembleOutput(body: string, tail: OutputTail): string {
  let content = body;
  if (tail.docs !== undefined) {
    content = appendRawBlock(
      content,
      renderDocsBlock(
        allDocs(tail.docs.docs),
        tail.docs.transform ?? ((t) => t),
        missingDocNotes(tail.docs.docs, tail.docs.decision.mode),
      ),
    );
  }
  if (tail.dbSchema !== undefined) {
    content = appendRawBlock(
      content,
      renderDbSchemaBlock(tail.dbSchema, tail.dbSchemaTransform ?? ((t) => t)),
    );
  }
  content = appendTailBlocks(content, tail);
  const notice = buildNotice(tail);
  return notice === undefined ? content : `${notice}\n${content}`;
}
