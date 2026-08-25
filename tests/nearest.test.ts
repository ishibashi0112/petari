import { describe, expect, it } from "vitest";
import { analyzeNearest, renderNearest, renderNearestReplace } from "../src/core/nearest.ts";

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

  it("前後 4 行のコンテキストを verdict: null で含める", () => {
    const a = analyzeNearest(FILE, ["        Pub_dbConNbom = New OracleConnection"]);
    const w = a.window!;
    expect(w.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(w.lines.map((l) => l.verdict)).toEqual([
      null,
      null,
      null,
      null,
      "match",
      null,
      null,
      null,
      null,
    ]);
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

  // 2026-08-25 実運用事例の再現: スナップショット側で空行が落ち、SEARCH に空行が不足していた
  it("実ファイル側の空行が SEARCH に欠けていても正しい領域に位置合わせし extra を立てる", () => {
    const file = [
      "    Private Sub Other()",
      "        DoSomething()",
      "    End Sub",
      "",
      "    Private Sub Update(io_Dt As DataTable)",
      "        Recalc_CostAmount(io_Dt)",
      "",
      "    End Sub",
      "End Module",
    ];
    const a = analyzeNearest(file, ["        Recalc_CostAmount(io_Dt)", "    End Sub"]);
    const w = a.window!;
    // 旧実装 (固定幅ウィンドウ) は先頭の End Sub 側の類似領域を拾っていた。行 6-8 が正解
    const inWindow = w.lines.filter((l) => l.verdict !== null);
    expect(inWindow.map((l) => l.lineNo)).toEqual([6, 7, 8]);
    expect(inWindow.map((l) => l.verdict)).toEqual(["match", "extra", "match"]);
    expect(w.matchCount).toBe(2);
    expect(w.extraCount).toBe(1);
    expect(w.extraBlankCount).toBe(1);
    expect(inWindow[1]!.note).toContain("空行");
  });

  it("SEARCH 側にだけある空行は unmatchedSearch として報告する", () => {
    const file = ["Sub A()", "    Call B()", "End Sub"];
    const a = analyzeNearest(file, ["Sub A()", "", "    Call B()"]);
    const w = a.window!;
    expect(w.unmatchedSearch).toEqual([{ index: 2, text: "", blank: true }]);
    expect(w.matchCount).toBe(2);
    expect(w.extraCount).toBe(0);
  });

  it("空行と内容行が対応してしまった differ には空行の注記を付ける", () => {
    const a = analyzeNearest(["Sub A()", "", "End Sub"], ["Sub A()", "    Dim x", "End Sub"]);
    const differ = a.window!.lines.find((l) => l.verdict === "differ")!;
    expect(differ.note).toContain("空行");
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

  it("空行 1 行の欠落なら + 印と修正のヒント (空行を名指し) を出す", () => {
    const file = ["        Recalc_CostAmount(io_Dt)", "", "    End Sub"];
    const a = analyzeNearest(file, ["        Recalc_CostAmount(io_Dt)", "    End Sub"]);
    const text = renderNearest(a).join("\n");
    expect(text).toContain("+     2│");
    expect(text).toContain("修正のヒント");
    expect(text).toContain("空行 1 行");
    expect(text).toContain("+ の行も含めてそのままコピー");
    expect(text).toContain("+ = 実ファイルにあるが SEARCH にない行");
  });

  it("SEARCH に無関係の行が挟まっているときは行数 (うち空行数) を示す", () => {
    const file = ["Sub A()", "    Log()", "", "End Sub"];
    const a = analyzeNearest(file, ["Sub A()", "End Sub"]);
    const text = renderNearest(a).join("\n");
    expect(text).toContain("SEARCH にない行が 2 行 (うち空行 1 行)");
  });
});

describe("renderNearestReplace", () => {
  it("REPLACE 基準の抜粋であることを明示する", () => {
    const a = analyzeNearest(
      ["Sub A()", "    Call B()", "End Sub"],
      ["Sub A()", "    Call C()"],
      false,
      "REPLACE",
    );
    const text = renderNearestReplace(a).join("\n");
    expect(text).toContain("REPLACE 側の内容に近い実ファイル領域");
    expect(text).toContain("REPLACE 2 行中 1 行が一致");
    expect(text).toContain("! = REPLACE と内容が異なる行");
  });

  it("window が null なら何も出さない", () => {
    const a = analyzeNearest(["alpha"], ["beta"], false, "REPLACE");
    expect(renderNearestReplace(a)).toEqual([]);
  });
});
