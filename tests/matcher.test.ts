import { describe, expect, it } from "vitest";
import {
  applyBlocks,
  contentEqualsStage,
  findContentStage,
  matchBlock,
  reindent,
} from "../src/core/matcher.ts";
import type { ReplaceBlock } from "../src/types.ts";

const block = (search: string[], replace: string[], index = 1): ReplaceBlock => ({
  search,
  replace,
  line: 1,
  index,
});

describe("matchBlock: 完全一致 (exact)", () => {
  it("1 行の完全一致", () => {
    const m = matchBlock(["a", "b", "c"], block(["b"], ["B"]));
    expect(m).toMatchObject({ ok: true, stage: "exact", start: 1, end: 2 });
  });

  it("複数行の完全一致", () => {
    const m = matchBlock(["a", "b", "c", "d"], block(["b", "c"], ["X"]));
    expect(m).toMatchObject({ ok: true, stage: "exact", start: 1, end: 3 });
  });

  it("ファイル先頭・末尾でもマッチする", () => {
    expect(matchBlock(["a", "b"], block(["a"], ["X"]))).toMatchObject({ ok: true, start: 0 });
    expect(matchBlock(["a", "b"], block(["b"], ["X"]))).toMatchObject({ ok: true, start: 1 });
  });

  it("ファイル全体とのマッチ", () => {
    const m = matchBlock(["a", "b"], block(["a", "b"], ["X"]));
    expect(m).toMatchObject({ ok: true, stage: "exact", start: 0, end: 2 });
  });

  it("完全一致が 1 箇所なら、trim 段階なら曖昧になる場合でも成功する", () => {
    // "x" と "x " が並ぶ: exact では "x" 1 箇所のみ、trim-end なら 2 箇所
    const m = matchBlock(["x", "x "], block(["x"], ["X"]));
    expect(m).toMatchObject({ ok: true, stage: "exact", start: 0 });
  });

  it("完全一致が複数 → ambiguous (フォールバックしない)", () => {
    const m = matchBlock(["dup", "mid", "dup"], block(["dup"], ["X"]));
    expect(m).toMatchObject({ ok: false, reason: "ambiguous", stage: "exact", count: 2 });
  });

  it("どの段階でも見つからない → not-found", () => {
    const m = matchBlock(["a", "b"], block(["zzz"], ["X"]));
    expect(m).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("インデントも含めて一致した場合は exact (置換はそのまま)", () => {
    const m = matchBlock(["  if (x) {", "  }"], block(["  if (x) {", "  }"], ["  while (x) {", "  }"]));
    expect(m).toMatchObject({ ok: true, stage: "exact" });
    expect(m.ok && m.replacement).toEqual(["  while (x) {", "  }"]);
  });
});

describe("matchBlock: 行末空白無視 (trim-end)", () => {
  it("ファイル側に行末空白がある場合にマッチする", () => {
    const m = matchBlock(["const a = 1;  ", "const b = 2;"], block(["const a = 1;"], ["const a = 10;"]));
    expect(m).toMatchObject({ ok: true, stage: "trim-end", start: 0 });
  });

  it("SEARCH 側に行末空白がある場合にマッチする", () => {
    const m = matchBlock(["const a = 1;"], block(["const a = 1;  "], ["const a = 10;"]));
    expect(m).toMatchObject({ ok: true, stage: "trim-end" });
  });

  it("REPLACE 側はそのまま使う (インデント補正しない)", () => {
    const m = matchBlock(["  foo();  "], block(["  foo();"], ["  bar();"]));
    expect(m.ok && m.replacement).toEqual(["  bar();"]);
  });

  it("trim-end で複数一致 → ambiguous", () => {
    const m = matchBlock(["x ", "x\t"], block(["x"], ["X"]));
    expect(m).toMatchObject({ ok: false, reason: "ambiguous", stage: "trim-end", count: 2 });
  });

  it("CRLF 由来のタブ・空白混在の行末を無視する", () => {
    const m = matchBlock(["End Sub \t"], block(["End Sub"], ["End Function"]));
    expect(m).toMatchObject({ ok: true, stage: "trim-end" });
  });
});

describe("matchBlock: インデント無視 (trim-all)", () => {
  it("インデント違いでマッチし、REPLACE を実ファイルのインデントに補正する", () => {
    const file = ["class A {", "    doWork();", "}"];
    const m = matchBlock(file, block(["doWork();"], ["doWorkFast();"]));
    expect(m).toMatchObject({ ok: true, stage: "trim-all", start: 1, end: 2 });
    expect(m.ok && m.replacement).toEqual(["    doWorkFast();"]);
  });

  it("ブロック内の相対インデントを維持する", () => {
    const file = ["  if (a) {", "    b();", "  }"];
    const search = ["if (a) {", "  b();", "}"];
    const replace = ["if (a) {", "  b();", "  c();", "}"];
    const m = matchBlock(file, block(search, replace));
    expect(m).toMatchObject({ ok: true, stage: "trim-all" });
    expect(m.ok && m.replacement).toEqual(["  if (a) {", "    b();", "    c();", "  }"]);
  });

  it("タブインデントのファイルに合わせて補正する", () => {
    const file = ["\tPrivate Sub Foo()", "\tEnd Sub"];
    const search = ["Private Sub Foo()", "End Sub"];
    const replace = ["Private Sub Foo(x As Integer)", "End Sub"];
    const m = matchBlock(file, block(search, replace));
    expect(m.ok && m.replacement).toEqual(["\tPrivate Sub Foo(x As Integer)", "\tEnd Sub"]);
  });

  it("SEARCH 側が深くインデントされていても補正できる", () => {
    const file = ["value = 1"];
    const m = matchBlock(file, block(["        value = 1"], ["        value = 2"]));
    expect(m).toMatchObject({ ok: true, stage: "trim-all" });
    expect(m.ok && m.replacement).toEqual(["value = 2"]);
  });

  it("REPLACE 内の空行はインデントを付けない", () => {
    const file = ["    a();"];
    const m = matchBlock(file, block(["a();"], ["a();", "", "b();"]));
    expect(m.ok && m.replacement).toEqual(["    a();", "", "    b();"]);
  });

  it("trim-all で複数一致 → ambiguous", () => {
    const file = ["  x = 1", "\tx = 1"];
    const m = matchBlock(file, block(["x = 1"], ["x = 2"]));
    expect(m).toMatchObject({ ok: false, reason: "ambiguous", stage: "trim-all", count: 2 });
  });

  it("空行を含む複数行ブロックもマッチする", () => {
    const file = ["  a();", "", "  b();"];
    const m = matchBlock(file, block(["a();", "", "b();"], ["c();"]));
    expect(m).toMatchObject({ ok: true, stage: "trim-all" });
    expect(m.ok && m.replacement).toEqual(["  c();"]);
  });
});

describe("matchBlock: 空行差無視 (blank-insensitive)", () => {
  it("実ファイルにある空行が SEARCH に無くてもマッチする (範囲は非空行で囲まれた範囲)", () => {
    const file = ["before", "a();", "", "b();", "after"];
    const m = matchBlock(file, block(["a();", "b();"], ["X"]));
    expect(m).toMatchObject({ ok: true, stage: "blank-insensitive", start: 1, end: 4 });
    expect(m.ok && m.replacement).toEqual(["X"]);
  });

  it("空行の数の差 (SEARCH 1 行 vs 実ファイル 2 行) を吸収する", () => {
    const file = ["a();", "", "", "b();"];
    const m = matchBlock(file, block(["a();", "", "b();"], ["X"]));
    expect(m).toMatchObject({ ok: true, stage: "blank-insensitive", start: 0, end: 4 });
  });

  it("SEARCH に空行があり実ファイルに無くてもマッチする", () => {
    const m = matchBlock(["a();", "b();"], block(["a();", "", "b();"], ["X"]));
    expect(m).toMatchObject({ ok: true, stage: "blank-insensitive", start: 0, end: 2 });
  });

  it("SEARCH の先頭・末尾の余分な空行は照合範囲に含めず、実ファイル側の外側の空行は保持する", () => {
    // SEARCH は先頭 2 行・末尾 1 行が空行 (実ファイルの空行は前後 1 行ずつ) → exact では落ち、
    // 4 段目で非空行 a(); だけが照合範囲になる
    const file = ["keep", "", "a();", "", "tail"];
    const { lines, results } = applyBlocks(file, [block(["", "", "a();", ""], ["X"])]);
    expect(results[0]).toMatchObject({ ok: true, stage: "blank-insensitive", start: 2, end: 3 });
    expect(lines).toEqual(["keep", "", "X", "", "tail"]);
  });

  it("内部の空行を含む範囲が置換され、REPLACE の空行はそのまま挿入される", () => {
    const file = ["a();", "", "b();"];
    const { lines } = applyBlocks(file, [block(["a();", "b();"], ["x();", "", "", "y();"])]);
    expect(lines).toEqual(["x();", "", "", "y();"]);
  });

  it("インデント差 (trim-all 相当) と空行差が併発しても reindent が効く", () => {
    const file = ["    a();", "", "    b();"];
    const m = matchBlock(file, block(["a();", "b();"], ["a();", "c();", "b();"]));
    expect(m).toMatchObject({ ok: true, stage: "blank-insensitive", start: 0, end: 3 });
    expect(m.ok && m.replacement).toEqual(["    a();", "    c();", "    b();"]);
  });

  it("空行除去後に 2 箇所一致 → ambiguous (positions は元行番号)", () => {
    const file = ["a();", "", "b();", "x", "a();", "", "b();"];
    const m = matchBlock(file, block(["a();", "b();"], ["X"]));
    expect(m).toMatchObject({
      ok: false,
      reason: "ambiguous",
      stage: "blank-insensitive",
      count: 2,
      positions: [0, 4],
    });
  });

  it("SEARCH が空行のみなら 4 段目は試行せず not-found", () => {
    const m = matchBlock(["a", "", "b"], block(["", ""], ["X"]));
    expect(m).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("空行以外の文字差があれば救われない (fuzzy はしない)", () => {
    const m = matchBlock(["a();", "", "b();"], block(["a();", "zzz();"], ["X"]));
    expect(m).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("既存 3 段で一意一致するケースは stage が変わらない (回帰確認)", () => {
    expect(matchBlock(["a", "", "b"], block(["a", "", "b"], ["X"]))).toMatchObject({
      ok: true,
      stage: "exact",
    });
    expect(matchBlock(["  a();"], block(["a();"], ["b();"]))).toMatchObject({
      ok: true,
      stage: "trim-all",
    });
  });

  it("applyBlocks: 先行ブロックが blank-insensitive で適用された後、後続ブロックも正しく照合される", () => {
    const file = ["a();", "", "b();", "c();"];
    const { lines, results } = applyBlocks(file, [
      block(["a();", "b();"], ["A();", "B();"], 1),
      block(["c();"], ["C();"], 2),
    ]);
    expect(results[0]).toMatchObject({ ok: true, stage: "blank-insensitive" });
    expect(results[1]).toMatchObject({ ok: true, stage: "exact" });
    expect(lines).toEqual(["A();", "B();", "C();"]);
  });
});

describe("reindent", () => {
  it("基準インデントを付け替える", () => {
    expect(reindent(["  a", "    b"], "  ", "\t")).toEqual(["\ta", "\t  b"]);
  });

  it("基準より浅い行は自身のインデントを基準に置き換える", () => {
    expect(reindent(["outer", "    inner"], "    ", "  ")).toEqual(["  outer", "  inner"]);
  });

  it("空行はそのまま", () => {
    expect(reindent(["a", ""], "", "  ")).toEqual(["  a", ""]);
  });
});

describe("applyBlocks: 複数ブロックの順次適用", () => {
  it("上から順に適用する", () => {
    const { lines, results } = applyBlocks(
      ["a", "b", "c"],
      [block(["a"], ["A"], 1), block(["c"], ["C"], 2)],
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(lines).toEqual(["A", "b", "C"]);
  });

  it("後続ブロックは先行ブロックの適用結果に対してマッチする", () => {
    // 2 個目のブロックは 1 個目が作った "NEW" にマッチする
    const { lines, results } = applyBlocks(
      ["old"],
      [block(["old"], ["NEW"], 1), block(["NEW"], ["NEW2"], 2)],
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(lines).toEqual(["NEW2"]);
  });

  it("先行ブロックが行数を変えても後続の位置決めに影響しない", () => {
    const { lines } = applyBlocks(
      ["a", "b", "c"],
      [block(["a"], ["a1", "a2", "a3"], 1), block(["c"], ["C"], 2)],
    );
    expect(lines).toEqual(["a1", "a2", "a3", "b", "C"]);
  });

  it("REPLACE 側が空ならその範囲を削除する", () => {
    const { lines } = applyBlocks(["keep", "remove me", "keep2"], [block(["remove me"], [])]);
    expect(lines).toEqual(["keep", "keep2"]);
  });

  it("失敗ブロックはスキップし、成功分だけ適用した結果と全結果を返す (--partial 用)", () => {
    const { lines, results } = applyBlocks(
      ["a", "b"],
      [block(["missing"], ["X"], 1), block(["b"], ["B"], 2)],
    );
    expect(results[0]).toMatchObject({ ok: false, reason: "not-found" });
    expect(results[1]).toMatchObject({ ok: true });
    expect(lines).toEqual(["a", "B"]);
  });

  it("先行ブロックの削除で後続が見つからなくなるケースを検出する", () => {
    const { results } = applyBlocks(
      ["target"],
      [block(["target"], ["changed"], 1), block(["target"], ["X"], 2)],
    );
    expect(results[1]).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("同じ SEARCH を 2 回書いたら 2 箇所を順に置換できる (適用後は一意になるため)", () => {
    // "dup" が 2 箇所 → 1 個目のブロックは ambiguous になる (仕様どおりエラー)
    const { results } = applyBlocks(["dup", "dup"], [block(["dup"], ["once"], 1)]);
    expect(results[0]).toMatchObject({ ok: false, reason: "ambiguous", count: 2 });
  });

  it("ブロックなしなら元の行を返す", () => {
    const { lines, results } = applyBlocks(["a"], []);
    expect(lines).toEqual(["a"]);
    expect(results).toEqual([]);
  });
});

describe("findContentStage: 適用済み判定 (冪等性)", () => {
  it("ブロック全体が完全一致で存在すれば exact", () => {
    const lines = ["a", "Dim x = 2", "If x Then", "c"];
    expect(findContentStage(lines, ["Dim x = 2", "If x Then"])).toBe("exact");
  });

  it("複数箇所に存在しても検出できる (曖昧エラーにしない)", () => {
    expect(findContentStage(["x", "mid", "x"], ["x"])).toBe("exact");
  });

  it("行末空白・インデント差は既存段階で吸収する", () => {
    expect(findContentStage(["const a = 1;  "], ["const a = 1;"])).toBe("trim-end");
    expect(findContentStage(["    const a = 1;"], ["  const a = 1;"])).toBe("trim-all");
  });

  it("行内の連続空白差は ws-collapse で吸収する (コメント前の空白数の差)", () => {
    const lines = ["wk_ItemSet.Add(c)   ' コメント"];
    expect(findContentStage(lines, ["wk_ItemSet.Add(c) ' コメント"])).toBe("ws-collapse");
  });

  it("一部の行しか一致しなければ null (ブロックまるごと一致が条件)", () => {
    expect(findContentStage(["a", "b"], ["a", "zzz"])).toBeNull();
  });

  it("空・空行のみの content は常に null (偶然一致の誤検出防止)", () => {
    expect(findContentStage(["a", "", "b"], [])).toBeNull();
    expect(findContentStage(["a", "", "b"], [""])).toBeNull();
    expect(findContentStage(["a", "  ", "b"], ["  "])).toBeNull();
  });

  it("存在しなければ null", () => {
    expect(findContentStage(["a", "b"], ["zzz"])).toBeNull();
  });
});

describe("contentEqualsStage: 全文一致の適用済み判定 (rewrite/create)", () => {
  it("全行一致なら exact、行数が違えば null", () => {
    expect(contentEqualsStage(["a", "b"], ["a", "b"])).toBe("exact");
    expect(contentEqualsStage(["a", "b", "c"], ["a", "b"])).toBeNull();
    expect(contentEqualsStage(["a"], ["a", "b"])).toBeNull();
  });

  it("空白差は presence 段階で吸収する", () => {
    expect(contentEqualsStage(["a  ", "b"], ["a", "b"])).toBe("trim-end");
    expect(contentEqualsStage(["f(1)   ' c"], ["f(1) ' c"])).toBe("ws-collapse");
  });

  it("空ファイル vs 空 content は exact (完全一致している)", () => {
    expect(contentEqualsStage([], [])).toBe("exact");
  });

  it("内容が違えば null", () => {
    expect(contentEqualsStage(["a"], ["b"])).toBeNull();
  });
});
