/**
 * 失敗レポート (§7)。そのまま AI チャットに貼り返せる形式で出力する。
 */
import type { Failure } from "./applier.ts";
import type { ParseIssue } from "../types.ts";

const RE_REQUEST = `## 依頼

上記の失敗した各ブロックについて、SEARCH 部分を現在のファイル内容と完全に一致するよう修正し、
changes.md 全体を元の規約フォーマット (## CHANGES から始まる形式) で再出力してください。
- SEARCH ブロックにはファイル内で一意に特定できる範囲を含めてください
- 失敗していないファイル・ブロックも含めた完全な changes.md を出力してください`;

/** 検証失敗 (マッチング・パス・エンコーディング) のレポート */
export function buildFailureReport(failures: Failure[]): string {
  const parts: string[] = [
    "以下の変更ブロックが現在のコードベースに適用できませんでした。",
    "",
    "## 適用失敗の詳細",
  ];
  for (const f of failures) {
    parts.push("", `### ${f.path}`, `失敗理由: ${f.message}`);
    if (f.block !== undefined) {
      parts.push(
        "",
        "```",
        "<<<<<<< SEARCH",
        ...f.block.search,
        "=======",
        ...f.block.replace,
        ">>>>>>> REPLACE",
        "```",
      );
    }
  }
  parts.push("", RE_REQUEST, "");
  return parts.join("\n");
}

/** 構文エラー (パース失敗) のレポート */
export function buildParseErrorReport(issues: ParseIssue[]): string {
  const parts: string[] = [
    "受け取った changes.md が規約フォーマットとして解釈できませんでした。",
    "",
    "## 構文エラーの詳細",
    "",
    ...issues.map((i) => `- ${i.line} 行目: ${i.message}`),
    "",
    "## 依頼",
    "",
    "上記の構文エラーを修正し、changes.md 全体を規約フォーマット (## CHANGES から始まり、",
    "### FILE: 行と <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 等のマーカーを行頭に置く形式) で",
    "再出力してください。",
    "",
  ];
  return parts.join("\n");
}
