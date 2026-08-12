import { describe, expect, it } from "vitest";
import { buildEditorPage, editorCsp, type EditorPageData } from "../src/core/editor-html.ts";

const data = (over: Partial<EditorPageData>): EditorPageData => ({
  path: "src/a.ts",
  leftLabel: "適用前 (before)",
  snapshotText: "hello\n",
  snapshotNote: null,
  currentText: "hello\n",
  baseSha256: "a".repeat(64),
  encodingLabel: "UTF-8",
  eolLabel: "LF",
  saved: false,
  errorBanner: null,
  blockReason: null,
  idleMinutes: 30,
  nonce: "TESTNONCE123",
  ...over,
});

describe("buildEditorPage: セキュリティ (§9)", () => {
  it("静的な script は JSON データと nonce 付きブートストラップの 2 個のみ", () => {
    const html = buildEditorPage(data({}));
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).toContain(`<script type="application/json" id="pd">`);
    expect(html).toContain(`<script nonce="TESTNONCE123">`);
    // monaco の読み込みは実行時に URL からトークンを得て行う (HTML に src= を書かない)
    expect(html).not.toMatch(/<script[^>]*src=/);
    // 外部リソース参照なし
    expect(html).not.toMatch(/src\s*=\s*"http/);
    expect(html).not.toMatch(/href\s*=\s*"http/);
  });

  it("editorCsp は同梱資産 ('self') と nonce スクリプトのみ許可する", () => {
    const csp = editorCsp("N");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-N'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("font-src data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("ファイル内容の </textarea><script> 注入を無効化する", () => {
    const evil = `</textarea><script>alert(1)</script>`;
    const html = buildEditorPage(data({ currentText: evil, snapshotText: evil }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;");
    // noscript フォールバックの正規の閉じタグは 1 個だけ
    expect(html.split("</textarea>")).toHaveLength(2);
  });

  it("埋め込み JSON 内の </script> は \\u003c エスケープで脱出できない", () => {
    const evil = `</script><script>alert(1)</script>`;
    const html = buildEditorPage(data({ snapshotText: evil, currentText: evil }));
    expect(html).toContain(`\\u003c/script`);
    expect(html).not.toContain(`</script><script>alert`);
  });
});

describe("buildEditorPage: フォールバックと §8 保全", () => {
  it("noscript フォームの textarea は開きタグ直後に改行を入れる", () => {
    const html = buildEditorPage(data({ currentText: "\nfirst line was empty\n" }));
    expect(html).toMatch(/<textarea[^>]*>\n\nfirst line was empty\n<\/textarea>/);
  });

  it("textarea の値は制御文字も加工せず保持する (無編集行の破壊防止)", () => {
    const bidi = "abc‮def";
    const html = buildEditorPage(data({ currentText: bidi }));
    expect(html).toContain("abc‮def");
  });

  it("hidden の baseSha256 とフォーム POST (action 相対) を持つ", () => {
    const html = buildEditorPage(data({}));
    expect(html).toContain(`name="baseSha256" value="${"a".repeat(64)}"`);
    expect(html).toContain(`<form method="post" action="">`);
    expect(html).toContain(`action="../quit"`);
    expect(html).toContain("<noscript>");
  });
});

describe("buildEditorPage: 表示 (§4.3)", () => {
  it("blockReason があるとエディタと textarea を出さない", () => {
    const html = buildEditorPage(data({ blockReason: "CR のみの改行を含むためブラウザ編集は非対応です" }));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(`<div id="ed">`);
    expect(html).toContain("ブラウザ編集は非対応");
    expect(html).toContain(`"blocked":true`);
  });

  it("saved / errorBanner / snapshotNote のバナーを表示する", () => {
    expect(buildEditorPage(data({ saved: true }))).toContain("保存しました");
    expect(buildEditorPage(data({ errorBanner: "変換できない文字: ①" }))).toContain("変換できない文字: ①");
    expect(
      buildEditorPage(data({ snapshotText: null, snapshotNote: "比較元スナップショットがありません (新規作成ファイル)" })),
    ).toContain("比較元スナップショットがありません");
  });

  it("ステータスバーにエンコーディング・改行コードを表示する", () => {
    const html = buildEditorPage(data({ encodingLabel: "Shift_JIS", eolLabel: "CRLF" }));
    expect(html).toContain("Shift_JIS");
    expect(html).toContain("CRLF");
    expect(html).toContain("無操作 30 分で自動終了");
  });
});
