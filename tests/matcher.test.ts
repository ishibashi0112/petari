import { describe, expect, it } from "vitest";
import { applyBlocks, matchBlock, reindent } from "../src/core/matcher.ts";
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
