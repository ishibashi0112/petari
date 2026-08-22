import { describe, expect, it } from "vitest";
import { parseChanges, parseChangesRecovering } from "../src/core/parser.ts";
import type { CreateFileChange, ReplaceFileChange } from "../src/types.ts";

/** 行配列を LF 結合で changes.md テキストにする */
const doc = (...lines: string[]): string => lines.join("\n");

const VALID = doc(
  "## CHANGES",
  "",
  "date.ts の書式修正。",
  "",
  "### FILE: src/utils/date.ts (replace)",
  "<<<<<<< SEARCH",
  "const fmt = 'YYYY/MM/DD';",
  "=======",
  "const fmt = 'YYYY-MM-DD';",
  ">>>>>>> REPLACE",
);

describe("parseChangesRecovering: strict 成功時", () => {
  it("strict で成功すればそのまま返し repairs は空", () => {
    const r = parseChangesRecovering(VALID);
    expect(r.issues).toEqual([]);
    expect(r.repairs).toEqual([]);
    expect(r.changeSet).toEqual(parseChanges(VALID).changeSet);
  });

  it("SEARCH 本文に ====== (6 個) を含む正しい文書は補正なしでそのまま通る", () => {
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: docs/readme.rst (replace)",
      "<<<<<<< SEARCH",
      "Title",
      "======",
      "old",
      "=======",
      "Title",
      "======",
      "new",
      ">>>>>>> REPLACE",
    );
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual([]);
    expect(r.repairs).toEqual([]);
    const rep = r.changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks[0]?.search).toEqual(["Title", "======", "old"]);
  });
});

describe("parseChangesRecovering: 寛容パースで救済", () => {
  it("全体がコードフェンスで包まれていても解釈できる", () => {
    const text = doc("以下が変更内容です。", "```markdown", VALID, "```");
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual([]);
    expect(r.repairs.length).toBeGreaterThan(0);
    expect(r.changeSet.files.map((f) => f.path)).toEqual(["src/utils/date.ts"]);
  });

  it("見出しレベルのずれ (# CHANGES / #### FILE:) を補正する", () => {
    const text = doc(
      "# CHANGES",
      "",
      "概要。",
      "",
      "#### FILE: src/a.ts (replace)",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
      // strict では # CHANGES を見出しとして認識できず preamble のまま終わるため失敗する
    );
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual([]);
    expect(r.repairs.map((x) => x.message).join("\n")).toContain("## CHANGES");
    expect(r.changeSet.files[0]?.path).toBe("src/a.ts");
  });

  it("マーカーの記号個数ずれ・スペース欠落を補正する", () => {
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: src/a.ts (replace)",
      "<<<<<<<SEARCH",
      "old",
      "======",
      "new",
      ">>>>>>>> REPLACE",
    );
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual([]);
    expect(r.repairs).toHaveLength(3);
    const rep = r.changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks[0]?.search).toEqual(["old"]);
    expect(rep.blocks[0]?.replace).toEqual(["new"]);
  });

  it("CONTENT マーカーのずれも補正する", () => {
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: src/new.ts (create)",
      "<<<<<<<< CONTENT",
      "export {};",
      ">>>>>>>END",
    );
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual([]);
    const c = r.changeSet.files[0] as CreateFileChange;
    expect(c.content).toEqual(["export {};"]);
  });

  it("CONTENT ブロック本文のフェンス行は除去しない (Markdown ファイルの生成)", () => {
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: docs/guide.md (create)",
      "<<<<<<< CONTENT",
      "# Guide",
      "```ts",
      "const a = 1;",
      "```",
      ">>>>>>> END",
      "```", // 全体を包んでいたフェンスの閉じ (これが strict を失敗させる)
    );
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual([]);
    const c = r.changeSet.files[0] as CreateFileChange;
    expect(c.content).toEqual(["# Guide", "```ts", "const a = 1;", "```"]);
    expect(r.repairs).toHaveLength(1);
  });
});

describe("parseChangesRecovering: フォールバック安全性", () => {
  it("寛容パースでも解決しない場合は strict の issues を返し repairs は空", () => {
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: src/a.ts (replace)",
      "<<<<<<< SEARCH",
      "old",
      // ======= も >>>>>>> REPLACE もない
    );
    const r = parseChangesRecovering(text);
    expect(r.issues).toEqual(parseChanges(text).issues);
    expect(r.repairs).toEqual([]);
  });

  it("寛容解釈が別の矛盾を生む場合は採用せず strict のエラーへ戻す", () => {
    // REPLACE 本文に ====== (6 個) を含み、末尾に迷い込んだフェンスで strict が失敗する文書。
    // 寛容パースは ====== を区切りと誤認して「区切りが複数」の issue を出すため破棄され、
    // strict のエラー (予期しない行) が返る = 静かな誤解釈をしない
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: docs/readme.rst (replace)",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "Title",
      "======",
      "new",
      ">>>>>>> REPLACE",
      "```",
    );
    const r = parseChangesRecovering(text);
    expect(r.repairs).toEqual([]);
    expect(r.issues).toEqual(parseChanges(text).issues);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("### FILE: 行の操作種別欠落は寛容パースでも救済しない (エラーのまま)", () => {
    const text = doc(
      "## CHANGES",
      "",
      "概要。",
      "",
      "### FILE: src/a.ts",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
    );
    const r = parseChangesRecovering(text);
    expect(r.repairs).toEqual([]);
    expect(r.issues.map((i) => i.message).join("\n")).toContain("FILE 行の形式が不正");
  });
});
