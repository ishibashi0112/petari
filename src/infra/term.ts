/**
 * 端末出力のサニタイズ (セキュリティレビュー指摘 4)。
 * changes.md 由来の文字列 (SEARCH 引用・プレビュー・パス表示) には
 * ANSI エスケープ等を仕込めるため、\n \t 以外の C0/C1 制御文字を除去してから出力する。
 * クリップボードへコピーするレポート本文は原文のまま (これは端末を通らない)。
 */
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]",
  "g",
);

export function sanitizeForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

export const out = (s: string): void => void process.stdout.write(sanitizeForTerminal(s) + "\n");
export const err = (s: string): void => void process.stderr.write(sanitizeForTerminal(s) + "\n");
