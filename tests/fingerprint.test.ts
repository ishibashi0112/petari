import { describe, expect, it } from "vitest";
import { changeSetFingerprint } from "../src/core/fingerprint.ts";
import { parseChangesRecovering } from "../src/core/parser.ts";

const doc = (...lines: string[]): string => lines.join("\n");

const fp = (text: string): string => {
  const r = parseChangesRecovering(text);
  expect(r.issues).toEqual([]);
  return changeSetFingerprint(r.changeSet);
};

const BODY = [
  "### FILE: a.vb (replace)",
  "<<<<<<< SEARCH",
  "Dim a = 1",
  "=======",
  "Dim a = 2",
  ">>>>>>> REPLACE",
  "",
  "### FILE: b.ts (create)",
  "<<<<<<< CONTENT",
  "export const b = 1;",
  ">>>>>>> END",
];

describe("changeSetFingerprint (§6.1 二重適用の検出)", () => {
  it("前置き・CHANGES 概要・改行コードが違っても変更内容が同じなら同じ指紋", () => {
    const a = fp(doc("## CHANGES", "", "概要 A", "", ...BODY));
    const b = fp(doc("了解しました。以下です。", "", "## CHANGES", "", "別の概要", "", ...BODY).replace(/\n/g, "\r\n"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("寛容パースで補正したマーカー表記の違いも同じ指紋", () => {
    const strict = fp(doc("## CHANGES", "", "概要", "", ...BODY));
    const loose = fp(
      doc("## CHANGES", "", "概要", "", ...BODY.map((l) => l.replace("<<<<<<< SEARCH", "<<<<<<<< SEARCH"))),
    );
    expect(loose).toBe(strict);
  });

  it("ブロックの中身・パス・操作が 1 つでも違えば別の指紋", () => {
    const base = fp(doc("## CHANGES", "", "概要", "", ...BODY));
    expect(fp(doc("## CHANGES", "", "概要", "", ...BODY.map((l) => l.replace("Dim a = 2", "Dim a = 3"))))).not.toBe(base);
    expect(fp(doc("## CHANGES", "", "概要", "", ...BODY.map((l) => l.replace("b.ts", "c.ts"))))).not.toBe(base);
  });
});
