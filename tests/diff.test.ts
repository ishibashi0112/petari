import { describe, expect, it } from "vitest";
import { diffLines, intralineRanges, toSideBySideRows, type DiffOp } from "../src/core/diff.ts";

/** ops を a に適用して b を再構築する (不変条件の検証用) */
const applyOps = (a: readonly string[], b: readonly string[], ops: DiffOp[]): string[] => {
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === "same") out.push(a[op.a] as string);
    else if (op.kind === "ins") out.push(b[op.b] as string);
  }
  return out;
};

/** ops が a / b の全行を順序通りちょうど 1 回ずつ消費していることの検証 */
const checkValid = (a: readonly string[], b: readonly string[], ops: DiffOp[]): void => {
  const aIdx = ops.filter((o) => o.kind !== "ins").map((o) => (o as { a: number }).a);
  const bIdx = ops.filter((o) => o.kind !== "del").map((o) => (o as { b: number }).b);
  expect(aIdx).toEqual([...a.keys()]);
  expect(bIdx).toEqual([...b.keys()]);
  for (const op of ops) {
    if (op.kind === "same") expect(a[op.a]).toBe(b[op.b]);
  }
  expect(applyOps(a, b, ops)).toEqual([...b]);
};

describe("diffLines (§4.3)", () => {
  it("空 vs 空は空の ops を返す", () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it("同一入力は全行 same になる", () => {
    const a = ["x", "y", "z"];
    const ops = diffLines(a, a);
    expect(ops.every((o) => o.kind === "same")).toBe(true);
    checkValid(a, a, ops);
  });

  it("共通行なしの全置換を再現できる", () => {
    const a = ["a1", "a2"];
    const b = ["b1", "b2", "b3"];
    checkValid(a, b, diffLines(a, b));
  });

  it("挿入のみを検出する", () => {
    const a = ["1", "2", "3"];
    const b = ["1", "new", "2", "3"];
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind === "ins")).toEqual([{ kind: "ins", b: 1 }]);
    expect(ops.filter((o) => o.kind === "del")).toEqual([]);
    checkValid(a, b, ops);
  });

  it("削除のみを検出する", () => {
    const a = ["1", "2", "3"];
    const b = ["1", "3"];
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind === "del")).toEqual([{ kind: "del", a: 1 }]);
    expect(ops.filter((o) => o.kind === "ins")).toEqual([]);
    checkValid(a, b, ops);
  });

  it("前後の共通部分を same として保持する", () => {
    const a = ["h1", "h2", "old", "t1", "t2"];
    const b = ["h1", "h2", "new1", "new2", "t1", "t2"];
    const ops = diffLines(a, b);
    checkValid(a, b, ops);
    // 前置き 2 行 + 後置き 2 行は same
    expect(ops.slice(0, 2).every((o) => o.kind === "same")).toBe(true);
    expect(ops.slice(-2).every((o) => o.kind === "same")).toBe(true);
  });

  it("重複行があっても正しく再現できる", () => {
    const a = ["x", "x", "x", "y", "x"];
    const b = ["x", "y", "x", "x"];
    checkValid(a, b, diffLines(a, b));
  });

  it("空行だけのファイル同士も扱える", () => {
    const a = ["", "", ""];
    const b = ["", ""];
    checkValid(a, b, diffLines(a, b));
  });

  it("maxD 打ち切り時も b を完全再現する (品質のみ低下)", () => {
    // 中間部が大きく乖離した入力に極小の maxD を与え、フォールバック経路を通す
    const a = ["head", ...Array.from({ length: 50 }, (_, i) => `a${i}`), "tail"];
    const b = ["head", ...Array.from({ length: 50 }, (_, i) => `b${i}`), "tail"];
    const ops = diffLines(a, b, 1);
    checkValid(a, b, ops);
    // 前置き・後置き以外は全削除 + 全挿入になる
    expect(ops.filter((o) => o.kind === "same")).toHaveLength(2);
  });

  it("疑似ランダム入力でも常に b を再現する (プロパティ)", () => {
    // 再現性のため線形合同法で決定的に生成する
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let trial = 0; trial < 30; trial++) {
      const pool = ["p", "q", "r", "s", ""];
      const a = Array.from({ length: rand(20) }, () => pool[rand(pool.length)] as string);
      const b = Array.from({ length: rand(20) }, () => pool[rand(pool.length)] as string);
      checkValid(a, b, diffLines(a, b));
    }
  });
});

describe("toSideBySideRows (§4.3)", () => {
  it("same 行は左右に同じテキストと 1-based 行番号を持つ", () => {
    const a = ["only"];
    const rows = toSideBySideRows(a, a, diffLines(a, a));
    expect(rows).toEqual([
      { kind: "same", left: { no: 1, text: "only" }, right: { no: 1, text: "only" } },
    ]);
  });

  it("連続する del/ins は change としてペア化される", () => {
    const a = ["keep", "old1", "old2", "end"];
    const b = ["keep", "new1", "end"];
    const rows = toSideBySideRows(a, b, diffLines(a, b));
    expect(rows[0]?.kind).toBe("same");
    expect(rows[1]).toEqual({
      kind: "change",
      left: { no: 2, text: "old1" },
      right: { no: 2, text: "new1" },
    });
    // 対応する挿入がない削除は del 単独行になる
    expect(rows[2]).toEqual({ kind: "del", left: { no: 3, text: "old2" }, right: null });
    expect(rows[3]?.kind).toBe("same");
  });

  it("挿入のみの行は右側だけを持つ", () => {
    const a = ["1"];
    const b = ["1", "2"];
    const rows = toSideBySideRows(a, b, diffLines(a, b));
    expect(rows[1]).toEqual({ kind: "ins", left: null, right: { no: 2, text: "2" } });
  });
});

describe("intralineRanges (§4.3)", () => {
  it("同一テキストは両側とも空", () => {
    expect(intralineRanges("abc", "abc")).toEqual({ left: [], right: [] });
  });

  it("1 文字置換は両側に同じ位置の範囲を返す", () => {
    expect(intralineRanges("abcdef", "abXdef")).toEqual({
      left: [{ start: 2, end: 3 }],
      right: [{ start: 2, end: 3 }],
    });
  });

  it("挿入のみは右側だけに範囲を返す", () => {
    const r = intralineRanges("hello world", "hello brave world");
    expect(r.left).toEqual([]);
    expect(r.right).toEqual([{ start: 6, end: 12 }]);
  });

  it("連続する変更文字は 1 つの範囲にまとまる", () => {
    const r = intralineRanges("aaaa", "abba");
    expect(r.right).toEqual([{ start: 1, end: 3 }]);
  });

  it("長すぎる行は行全体の範囲にフォールバックする", () => {
    const long = "x".repeat(1001);
    const r = intralineRanges(long, "y");
    expect(r.left).toEqual([{ start: 0, end: 1001 }]);
    expect(r.right).toEqual([{ start: 0, end: 1 }]);
  });

  it("マルチバイト文字もコードポイント単位で数える", () => {
    const r = intralineRanges("こんにちは", "こんばんは");
    expect(r.left).toEqual([{ start: 2, end: 4 }]);
    expect(r.right).toEqual([{ start: 2, end: 4 }]);
  });
});
