/**
 * 端末出力のサニタイズ (セキュリティレビュー指摘 4)。
 * changes.md 由来の文字列 (SEARCH 引用・プレビュー・パス表示) には
 * ANSI エスケープ等を仕込めるため、\n \t 以外の C0/C1 制御文字を除去してから出力する。
 * クリップボードへコピーするレポート本文は原文のまま (これは端末を通らない)。
 */
// C0/C1 制御文字 (\n \t 以外) に加え、表示順序を偽装できる双方向制御文字
// (Trojan Source 対策: LRM/RLM/ALM・LRE〜PDF・LRI〜PDI) も除去する
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g",
);

export function sanitizeForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

export const out = (s: string): void => void process.stdout.write(sanitizeForTerminal(s) + "\n");
export const err = (s: string): void => void process.stderr.write(sanitizeForTerminal(s) + "\n");

const RESET = "\u001B[0m";
const BOLD_YELLOW = "\u001B[1;33m";
const BOLD_REVERSE_YELLOW = "\u001B[1;7;33m";

/**
 * 目立たせたい行の出力。装飾コードはこのファイルのリテラル定数のみで、
 * 本文はサニタイズ後に着色するため ANSI 注入対策 (上記) は保たれる。
 * 非 TTY (パイプ・リダイレクト) と NO_COLOR 指定時は装飾なしで出力する。
 */
export const outEmphasis = (s: string, reverse = false): void => {
  const clean = sanitizeForTerminal(s);
  const decorate =
    process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
  const colored = decorate ? `${reverse ? BOLD_REVERSE_YELLOW : BOLD_YELLOW}${clean}${RESET}` : clean;
  process.stdout.write(colored + "\n");
};
