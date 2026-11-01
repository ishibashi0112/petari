/**
 * 規約文(changes.md の出力規約)の解決と出力末尾への連結。
 *
 * 規約文は内蔵(src/assets/protocol.ts)。パックの末尾に <instruction> として連結し、
 * AI へ渡すコンテキストに規約を含める(本家 repomix の instructionFilePath 相当)。
 * 設計書 §25.3-1(旧 slnmix は petari init が書き出した protocol.md を読んでいた)。
 *
 * - 既定: 内蔵の規約文。ルートに protocol.md があれば、それは「置いたときだけ使う上書き」
 *   (手順文の procedure.md と同じ)。ただし 1 行目の版と本文が内蔵の第 N 版と一字一句同じ
 *   (改行コードと末尾の改行は問わない)なら、旧 petari init が書いたまま手を加えていない
 *   ものとみなして内蔵の最新版を使い、削除してよいと案内する。違えば上書きとして使い、
 *   内蔵より古い版をもとにしていれば警告する(どちらも機械的な比較で、推測はしない)
 * - --instruction-file 指定時: そのファイルを使う(読めなければエラー)
 * - --no-instruction: 規約文を連結しない
 *
 * ファイルシステムは deps 注入とし、単体テスト可能に保つ。
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { PAST_PROTOCOL_SHA256, PROTOCOL_TEXT, PROTOCOL_VERSION } from "../assets/protocol.ts";
import { TOOL_NAME } from "../brand.ts";

export interface InstructionFileDeps {
  /** ファイルを読み文字列で返す(存在しない・読めないときは undefined) */
  readTextFile(absolutePath: string): string | undefined;
}

export type InstructionSource =
  /** 内蔵の規約文。unmodifiedFile は手を加えていない protocol.md(使わない。削除してよい) */
  | { kind: "builtin"; unmodifiedFile?: { path: string; version: number } | undefined }
  /** ファイルの規約文。baseVersion は 1 行目の版(無ければ undefined) */
  | { kind: "file"; path: string; explicit: boolean; baseVersion: number | undefined };

export type InstructionResolution =
  | { kind: "found"; content: string; source: InstructionSource }
  /** --no-instruction */
  | { kind: "none" }
  | { kind: "error"; message: string };

export const DEFAULT_INSTRUCTION_FILE_NAME = "protocol.md";

const VERSION_LINE = /^\s*<!--\s*petari protocol v(\d+)\s*-->/;

function normalizeForComparison(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 1 行目の版(`<!-- petari protocol vN -->`)。無ければ undefined */
export function protocolVersionOf(text: string): number | undefined {
  const match = VERSION_LINE.exec(text.replace(/^\uFEFF/, ""));
  return match === null ? undefined : Number(match[1]);
}

/** 内蔵の規約文(過去の版を含む)と一字一句同じなら、その版。違えば undefined */
export function builtinProtocolVersionOf(text: string): number | undefined {
  const hash = sha256(normalizeForComparison(text));
  if (hash === sha256(normalizeForComparison(PROTOCOL_TEXT))) {
    return PROTOCOL_VERSION;
  }
  return PAST_PROTOCOL_SHA256.find((entry) => entry.sha256 === hash)?.version;
}

/**
 * @param explicitPath --instruction-file の値(省略時 undefined)
 * @param rootDir 上書きの protocol.md を探すディレクトリ(ルート)
 * @param cwd 実行時のカレントディレクトリ(explicitPath の解決基準)
 * @param disabled --no-instruction
 */
export function resolveInstructionFile(
  explicitPath: string | undefined,
  rootDir: string,
  cwd: string,
  deps: InstructionFileDeps,
  disabled = false,
): InstructionResolution {
  if (disabled) {
    return { kind: "none" };
  }
  if (explicitPath !== undefined) {
    const absolutePath = path.resolve(cwd, explicitPath);
    const content = deps.readTextFile(absolutePath);
    if (content === undefined) {
      return {
        kind: "error",
        message: `--instruction-file のファイルを読み込めません: ${absolutePath}`,
      };
    }
    return {
      kind: "found",
      content,
      source: { kind: "file", path: absolutePath, explicit: true, baseVersion: protocolVersionOf(content) },
    };
  }
  const filePath = path.join(rootDir, DEFAULT_INSTRUCTION_FILE_NAME);
  const content = deps.readTextFile(filePath);
  if (content === undefined) {
    return { kind: "found", content: PROTOCOL_TEXT, source: { kind: "builtin" } };
  }
  const builtinVersion = builtinProtocolVersionOf(content);
  if (builtinVersion !== undefined) {
    return {
      kind: "found",
      content: PROTOCOL_TEXT,
      source: { kind: "builtin", unmodifiedFile: { path: filePath, version: builtinVersion } },
    };
  }
  return {
    kind: "found",
    content,
    source: { kind: "file", path: filePath, explicit: false, baseVersion: protocolVersionOf(content) },
  };
}

/** 端末に出す 1 行と、内蔵より古い版をもとにした上書きの警告 */
export function describeInstruction(resolution: InstructionResolution): {
  line: string;
  warning?: string | undefined;
} {
  if (resolution.kind === "error") {
    return { line: resolution.message };
  }
  if (resolution.kind === "none") {
    return { line: "規約文: なし(--no-instruction)" };
  }
  const source = resolution.source;
  if (source.kind === "builtin") {
    const file = source.unmodifiedFile;
    if (file === undefined) {
      return { line: `規約文: 内蔵 v${PROTOCOL_VERSION}` };
    }
    const same =
      file.version === PROTOCOL_VERSION ? "内蔵と同じ内容" : `内蔵の v${file.version} のまま手を加えていないもの`;
    return {
      line: `規約文: 内蔵 v${PROTOCOL_VERSION}(${file.path} は${same}なので使いません。削除してかまいません)`,
    };
  }
  const line = `規約文: ${source.path}(${source.explicit ? "--instruction-file" : `内蔵 v${PROTOCOL_VERSION} の代わりに使う上書き`})`;
  if (source.baseVersion !== undefined && source.baseVersion < PROTOCOL_VERSION) {
    return {
      line,
      warning: `[warning] ${source.path} は規約文 v${source.baseVersion} に手を加えたものです(内蔵は v${PROTOCOL_VERSION})。内蔵の最新版を使うなら削除し、残したい変更は最新の文面(npx ${TOOL_NAME} protocol で表示)に入れ直してください`,
    };
  }
  return { line };
}

/**
 * 出力先頭に付けるリマインダ文(サンドイッチ配置の先頭側)。
 *
 * チャットサービスが長文添付を要約・検索で処理すると末尾の規約文が
 * モデルに届かないことがあるため、保持されやすい冒頭に「末尾を見ろ」という
 * ポインタを置く。文面は規約文 v2 以降と同じく「ユーザー本人からの
 * 指示」と自己宣言する設計。規約文の中身には依存しない。
 */
export const INSTRUCTION_NOTICE = `[このファイルを添付したユーザー本人からの恒常的な指示]
この添付の末尾に、コード変更を提案する際の出力規約(changes.md 形式)が
instruction ブロックとして含まれています。この会話でコードの変更を提案する
ときは、チャット本文で個別に言及されていなくても、必ず末尾の規約に従って
changes.md を出力してください。
`;

/**
 * 規約文が見つかったときだけ、出力の最先頭(repomix 互換ヘッダーより前)に
 * リマインダ文を付ける。規約文なしなら本文をそのまま返す(従来と同一の出力)。
 * appendInstruction と対で使い、末尾全文とのサンドイッチ配置にする。
 */
export function prependInstructionNotice(
  content: string,
  instruction: InstructionResolution,
): string {
  if (instruction.kind !== "found") {
    return content;
  }
  return `${INSTRUCTION_NOTICE}\n${content}`;
}

/**
 * 出力本文の末尾にテキストを <tag> ブロックとして連結する。
 * テキストは一字一句そのまま(整形・エスケープなし)。本文との間には空行を
 * 挟み、閉じタグが独立行になるよう末尾の改行だけ補う。
 * <task> / <plan> / <procedure>(procedureFile.ts)も同じ形で連結する。
 */
export function appendBlock(
  content: string,
  tag: string,
  text: string,
): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}<${tag}>\n${body}</${tag}>\n`;
}

/** 出力本文の末尾に規約文を <instruction> ブロックとして連結する */
export function appendInstruction(
  content: string,
  instructionText: string,
): string {
  return appendBlock(content, "instruction", instructionText);
}
