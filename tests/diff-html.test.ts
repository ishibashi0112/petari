import { describe, expect, it } from "vitest";
import { toSideBySideRows, diffLines, type DiffRow } from "../src/core/diff.ts";
import {
  MAX_SECTION_ROWS,
  buildIndexPage,
  buildMessagePage,
  buildReportPage,
  escapeHtml,
} from "../src/core/diff-html.ts";

describe("escapeHtml (§9)", () => {
  it("HTML 特殊文字 5 種を全てエスケープする", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("buildReportPage (§4.3)", () => {
  it("meta CSP と charset を含み、外部リソース参照がない", () => {
    const html = buildReportPage("petari 履歴 X", "2026-08-12", []);
    expect(html).toContain(`http-equiv="Content-Security-Policy"`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`<meta charset="utf-8">`);
    expect(html).not.toMatch(/src\s*=\s*"http/);
    expect(html).not.toMatch(/href\s*=\s*"http/);
  });

  it("閲覧レポートは JS を含まない", () => {
    const html = buildReportPage("t", "now", []);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("script-src");
  });

  it("ファイル内容の HTML をエスケープする", () => {
    const a = [`<img src=x onerror=alert(1)>`];
    const rows = toSideBySideRows(a, a, diffLines(a, a));
    const html = buildReportPage("t", "now", [
      { path: "a.html", op: "replace", body: { kind: "rows", rows, leftLabel: "l", rightLabel: "r" } },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("表示テキストからは双方向制御文字を除去する (Trojan Source 対策)", () => {
    const a = ["abc‮def"];
    const rows = toSideBySideRows(a, a, diffLines(a, a));
    const html = buildReportPage("t", "now", [
      { path: "a.txt", op: "replace", body: { kind: "rows", rows, leftLabel: "l", rightLabel: "r" } },
    ]);
    expect(html).not.toContain("‮");
  });

  it("上限行数を超えた分は省略表示になる", () => {
    const rows: DiffRow[] = Array.from({ length: MAX_SECTION_ROWS + 5 }, (_, i) => ({
      kind: "same" as const,
      left: { no: i + 1, text: "x" },
      right: { no: i + 1, text: "x" },
    }));
    const html = buildReportPage("t", "now", [
      { path: "big.txt", op: "rewrite", body: { kind: "rows", rows, leftLabel: "l", rightLabel: "r" } },
    ]);
    expect(html).toContain("以降 5 行を省略しました");
  });

  it("note セクション (バイナリ等) を表示する", () => {
    const html = buildReportPage("t", "now", [
      { path: "bin.dat", op: "rewrite", body: { kind: "note", note: "バイナリのため表示できません" } },
    ]);
    expect(html).toContain("バイナリのため表示できません");
  });

  it("change 行は文字単位のハイライト span を含む", () => {
    const a = ["const x = 1;"];
    const b = ["const x = 2;"];
    const rows = toSideBySideRows(a, b, diffLines(a, b));
    const html = buildReportPage("t", "now", [
      { path: "a.ts", op: "replace", body: { kind: "rows", rows, leftLabel: "l", rightLabel: "r" } },
    ]);
    expect(html).toContain(`<span class="hl">1</span>`);
    expect(html).toContain(`<span class="hl">2</span>`);
  });

  it("長い未変更ランは details で折りたたまれ、変更前後の文脈は見える", () => {
    const a = [...Array.from({ length: 30 }, (_, i) => `head${i}`), "old", ...Array.from({ length: 30 }, (_, i) => `tail${i}`)];
    const b = [...Array.from({ length: 30 }, (_, i) => `head${i}`), "new", ...Array.from({ length: 30 }, (_, i) => `tail${i}`)];
    const rows = toSideBySideRows(a, b, diffLines(a, b));
    const html = buildReportPage("t", "now", [
      { path: "a.txt", op: "replace", body: { kind: "rows", rows, leftLabel: "l", rightLabel: "r" } },
    ]);
    expect(html).toContain(`<details class="fold">`);
    expect(html).toContain("未変更の 27 行を表示");
    expect(html).toContain("head29");
  });

  it("全行一致のファイルは「変更はありません」を表示する", () => {
    const a = ["same1", "same2"];
    const rows = toSideBySideRows(a, a, diffLines(a, a));
    const html = buildReportPage("t", "now", [
      { path: "a.txt", op: "replace", body: { kind: "rows", rows, leftLabel: "l", rightLabel: "r" } },
    ]);
    expect(html).toContain("変更はありません (全 2 行一致)");
  });
});

describe("buildIndexPage / buildMessagePage (§4.3)", () => {
  it("一覧は相対リンク f/<n> と終了フォームを持つ", () => {
    const html = buildIndexPage("履歴 X", [
      { path: "a.ts", op: "replace", note: null },
      { path: "b.bin", op: "rewrite", note: "バイナリのため編集不可" },
    ], 30);
    expect(html).toContain(`href="f/0"`);
    expect(html).toContain(`href="f/1"`);
    expect(html).toContain("バイナリのため編集不可");
    expect(html).toContain(`action="quit"`);
    // トークンを含む絶対パスは埋め込まない
    expect(html).not.toMatch(/href="\//);
    expect(html).not.toMatch(/action="\//);
  });

  it("メッセージページはタイトル・本文・戻るリンクを持つ", () => {
    const html = buildMessagePage("競合", "外部で変更されています", "../");
    expect(html).toContain("競合");
    expect(html).toContain("外部で変更されています");
    expect(html).toContain(`href="../"`);
  });
});
