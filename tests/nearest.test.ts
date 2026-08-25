import { describe, expect, it } from "vitest";
import { analyzeNearest, renderNearest } from "../src/core/nearest.ts";

const FILE = [
  "Module mj_SVMD",
  "",
  "    Private Sub EnsureNbomConnected()",
  "        Dim wk_Ret As String = vbNullString",
  "        Pub_dbConNbom = New OracleConnection",
  "        wk_Ret = Pub_dbConNbom.State.ToString()",
  "    End Sub",
  "",
  "End Module",
];

describe("analyzeNearest", () => {
  it("最も一致行数の多い領域を特定し、不一致行に differ を付ける", () => {
    const a = analyzeNearest(FILE, [
      "    Private Sub EnsureNbomConnected()",
      "        Dim wk_Ret As String",
      "        Pub_dbConNbom = New OracleConnection",
    ]);
    expect(a.window).not.toBeNull();
    const w = a.window!;
    expect(w.total).toBe(3);
    expect(w.matchCount).toBe(2);
    const inWindow = w.lines.filter((l) => l.verdict !== null);
    expect(inWindow.map((l) => l.lineNo)).toEqual([3, 4, 5]);
    expect(inWindow.map((l) => l.verdict)).toEqual(["match", "differ", "match"]);
  });

  it("前後 2 行のコンテキストを verdict: null で含める", () => {
    const a = analyzeNearest(FILE, ["        Pub_dbConNbom = New OracleConnection"]);
    const w = a.window!;
    expect(w.lines.map((l) => l.lineNo)).toEqual([3, 4, 5, 6, 7]);
    expect(w.lines.map((l) => l.verdict)).toEqual([null, null, "match", null, null]);
  });

  it("lineHits: 各行の出現数を数え、空行は対象外", () => {
    const a = analyzeNearest(FILE, ["    End Sub", "", "存在しない行"]);
    expect(a.lineHits).toEqual([
      { index: 1, text: "    End Sub", count: 1 },
      { index: 3, text: "存在しない行", count: 0 },
    ]);
  });

  it("どの行も一致しなければ window は null", () => {
    const a = analyzeNearest(FILE, ["alpha", "beta"]);
    expect(a.window).toBeNull();
    expect(a.lineHits.every((h) => h.count === 0)).toBe(true);
  });

  it("行内の連続空白の個数だけ違う行は ws-only (SEARCH のマッチでは吸収されない差)", () => {
    const a = analyzeNearest(["If x Then  Call Foo()"], ["If x Then Call Foo()"]);
    const line = a.window!.lines[0]!;
    expect(line.verdict).toBe("ws-only");
    expect(line.note).toContain("連続空白の個数");
  });

  it("全角スペースの差は differ + 不可視文字ノート (コードポイント付き)", () => {
    const a = analyzeNearest(["If x Then　Call Foo()"], ["If x Then Call Foo()"]);
    const line = a.window!.lines[0]!;
    expect(line.verdict).toBe("differ");
    expect(line.note).toContain("区別しづらい文字");
    expect(line.note).toContain("U+3000");
    expect(line.note).toContain("U+0020");
  });

  it("波ダッシュ (U+301C) と全角チルダ (U+FF5E) の差も不可視文字ノートになる", () => {
    const a = analyzeNearest(["' A〜B"], ["' A～B"]);
    const line = a.window!.lines[0]!;
    expect(line.verdict).toBe("differ");
    expect(line.note).toContain("U+301C");
  });

  it("明確に内容が違う行にはノートを付けない (抜粋自体が説明になる)", () => {
    const a = analyzeNearest(
      ["        Dim wk_Ret As String = vbNullString", "    End Sub"],
      ["        Dim wk_Ret As String", "    End Sub"],
    );
    const line = a.window!.lines.find((l) => l.verdict === "differ")!;
    expect(line.note).toBeUndefined();
  });
});

describe("renderNearest", () => {
  it("抜粋は行番号ガター付き・本文は verbatim で、凡例を含む", () => {
    const a = analyzeNearest(FILE, [
      "    Private Sub EnsureNbomConnected()",
      "        Dim wk_Ret As String",
    ]);
    const text = renderNearest(a).join("\n");
    expect(text).toContain("実ファイルの該当箇所");
    expect(text).toContain("│    Private Sub EnsureNbomConnected()");
    expect(text).toContain("│        Dim wk_Ret As String = vbNullString");
    expect(text).toContain("凡例");
    // 存在しない行の一覧
    expect(text).toContain("SEARCH 2 行目: Dim wk_Ret As String");
  });

  it("window が null のときはスナップショット陳腐化の可能性を明示する", () => {
    const a = analyzeNearest(FILE, ["alpha"]);
    const text = renderNearest(a).join("\n");
    expect(text).toContain("どの行も");
    expect(text).toContain("スナップショット");
  });

  it("先行ブロック適用後の内容が基準であることを注記できる", () => {
    const a = analyzeNearest(FILE, ["    End Sub"], true);
    const text = renderNearest(a).join("\n");
    expect(text).toContain("先行ブロック");
  });
});
