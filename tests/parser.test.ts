import { describe, expect, it } from "vitest";
import { parseChanges } from "../src/core/parser.ts";
import type { CreateFileChange, ReplaceFileChange, RewriteFileChange } from "../src/types.ts";

/** 行配列を LF 結合で changes.md テキストにする */
const doc = (...lines: string[]): string => lines.join("\n");

const VALID = doc(
  "## CHANGES",
  "",
  "date.ts の書式修正と New.tsx の追加。",
  "",
  "- src/utils/date.ts",
  "- src/components/New.tsx",
  "",
  "### FILE: src/utils/date.ts (replace)",
  "<<<<<<< SEARCH",
  "const fmt = 'YYYY/MM/DD';",
  "=======",
  "const fmt = 'YYYY-MM-DD';",
  ">>>>>>> REPLACE",
  "",
  "### FILE: src/components/New.tsx (create)",
  "<<<<<<< CONTENT",
  "export const New = () => null;",
  ">>>>>>> END",
  "",
  "### FILE: src/legacy/Old.vb (rewrite)",
  "<<<<<<< CONTENT",
  "Module Old",
  "End Module",
  ">>>>>>> END",
  "",
  "### FILE: src/legacy/Unused.vb (delete)",
);

describe("parseChanges: 正常系", () => {
  it("§3.1 の 4 操作をすべてパースする", () => {
    const { changeSet, issues } = parseChanges(VALID);
    expect(issues).toEqual([]);
    expect(changeSet.files.map((f) => [f.op, f.path])).toEqual([
      ["replace", "src/utils/date.ts"],
      ["create", "src/components/New.tsx"],
      ["rewrite", "src/legacy/Old.vb"],
      ["delete", "src/legacy/Unused.vb"],
    ]);
    const rep = changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks).toHaveLength(1);
    expect(rep.blocks[0]?.search).toEqual(["const fmt = 'YYYY/MM/DD';"]);
    expect(rep.blocks[0]?.replace).toEqual(["const fmt = 'YYYY-MM-DD';"]);
    const create = changeSet.files[1] as CreateFileChange;
    expect(create.content).toEqual(["export const New = () => null;"]);
    const rewrite = changeSet.files[2] as RewriteFileChange;
    expect(rewrite.content).toEqual(["Module Old", "End Module"]);
  });

  it("CHANGES ヘッダ本文を外側の空行を除いて保持する", () => {
    const { changeSet } = parseChanges(VALID);
    expect(changeSet.header).toBe(
      doc("date.ts の書式修正と New.tsx の追加。", "", "- src/utils/date.ts", "- src/components/New.tsx"),
    );
  });

  it("Mermaid 図をヘッダ内にそのまま保持する", () => {
    const { changeSet, issues } = parseChanges(
      doc(
        "## CHANGES",
        "概要です。",
        "```mermaid",
        "flowchart TD",
        "  A --> B",
        "```",
        "### FILE: a.ts (delete)",
      ),
    );
    expect(issues).toEqual([]);
    expect(changeSet.header).toContain("flowchart TD");
    expect(changeSet.header).toContain("  A --> B");
  });

  it("CRLF の changes.md をパースできる", () => {
    const { changeSet, issues } = parseChanges(VALID.replaceAll("\n", "\r\n"));
    expect(issues).toEqual([]);
    expect(changeSet.files).toHaveLength(4);
    const rep = changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks[0]?.search).toEqual(["const fmt = 'YYYY/MM/DD';"]);
  });

  it("## CHANGES より前の前置きテキストは無視する", () => {
    const { changeSet, issues } = parseChanges(
      doc("以下が変更指示です。", "", VALID),
    );
    expect(issues).toEqual([]);
    expect(changeSet.files).toHaveLength(4);
    expect(changeSet.header).not.toContain("以下が変更指示です");
  });

  it("同一ファイルの複数 replace ブロックを順序どおり保持する", () => {
    const { changeSet, issues } = parseChanges(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "one",
        "=======",
        "ONE",
        ">>>>>>> REPLACE",
        "<<<<<<< SEARCH",
        "two",
        "=======",
        "TWO",
        ">>>>>>> REPLACE",
      ),
    );
    expect(issues).toEqual([]);
    const rep = changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks.map((b) => [b.index, b.search[0], b.replace[0]])).toEqual([
      [1, "one", "ONE"],
      [2, "two", "TWO"],
    ]);
  });

  it("Windows 形式のパス区切りを / に正規化する", () => {
    const { changeSet, issues } = parseChanges(
      doc("## CHANGES", "概要", "### FILE: src\\legacy\\Old.vb (delete)"),
    );
    expect(issues).toEqual([]);
    expect(changeSet.files[0]?.path).toBe("src/legacy/Old.vb");
  });

  it("ブロック内のマーカー風の行 (字下げ・字数違い) は本文として扱う", () => {
    const { changeSet, issues } = parseChanges(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.md (replace)",
        "<<<<<<< SEARCH",
        "  <<<<<<< SEARCH",   // 字下げ → 本文
        "========",           // = が 8 個 → 本文
        "<<<<<<<< SEARCH",    // < が 8 個 → 本文
        "=======",
        "### FILE: b.ts (replace)", // REPLACE 側の本文 (ブロック内は境界にならない)
        ">>>>>>> REPLACE",
      ),
    );
    expect(issues).toEqual([]);
    expect(changeSet.files).toHaveLength(1);
    const rep = changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks[0]?.search).toEqual([
      "  <<<<<<< SEARCH",
      "========",
      "<<<<<<<< SEARCH",
    ]);
    expect(rep.blocks[0]?.replace).toEqual(["### FILE: b.ts (replace)"]);
  });

  it("CONTENT ブロック内の ### FILE: 行は本文として扱う", () => {
    const { changeSet, issues } = parseChanges(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: doc/spec.md (create)",
        "<<<<<<< CONTENT",
        "### FILE: これは本文 (delete)",
        ">>>>>>> END",
      ),
    );
    expect(issues).toEqual([]);
    expect(changeSet.files).toHaveLength(1);
    expect((changeSet.files[0] as CreateFileChange).content).toEqual([
      "### FILE: これは本文 (delete)",
    ]);
  });

  it("REPLACE 側が空 (コード削除) を許容する", () => {
    const { changeSet, issues } = parseChanges(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "obsolete();",
        "=======",
        ">>>>>>> REPLACE",
      ),
    );
    expect(issues).toEqual([]);
    expect((changeSet.files[0] as ReplaceFileChange).blocks[0]?.replace).toEqual([]);
  });

  it("空の CONTENT (空ファイル作成) を許容する", () => {
    const { changeSet, issues } = parseChanges(
      doc("## CHANGES", "概要", "### FILE: empty.txt (create)", "<<<<<<< CONTENT", ">>>>>>> END"),
    );
    expect(issues).toEqual([]);
    expect((changeSet.files[0] as CreateFileChange).content).toEqual([]);
  });

  it("マーカー行の行末空白は許容し、本文の行末空白は保持する", () => {
    const { changeSet, issues } = parseChanges(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH  ",
        "keep trailing  ",
        "=======\t",
        "new",
        ">>>>>>> REPLACE ",
      ),
    );
    expect(issues).toEqual([]);
    const rep = changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks[0]?.search).toEqual(["keep trailing  "]);
  });

  it("ブロック位置 (行番号) を記録する", () => {
    const { changeSet } = parseChanges(VALID);
    const rep = changeSet.files[0] as ReplaceFileChange;
    expect(changeSet.files[0]?.line).toBe(8); // "### FILE: src/utils/date.ts (replace)"
    expect(rep.blocks[0]?.line).toBe(9); // "<<<<<<< SEARCH"
  });
});

describe("parseChanges: 異常系", () => {
  const issuesOf = (text: string): string[] =>
    parseChanges(text).issues.map((i) => i.message);

  it("## CHANGES がない", () => {
    expect(issuesOf(doc("### FILE: a.ts (delete)"))).toEqual([
      expect.stringContaining("## CHANGES セクションがありません"),
    ]);
  });

  it("FILE 行に操作種別がない", () => {
    const msgs = issuesOf(doc("## CHANGES", "概要", "### FILE: a.ts"));
    expect(msgs.some((m) => m.includes("FILE 行の形式が不正"))).toBe(true);
  });

  it("未知の操作種別 (rename)", () => {
    const msgs = issuesOf(doc("## CHANGES", "概要", "### FILE: a.ts (rename)"));
    expect(msgs.some((m) => m.includes("FILE 行の形式が不正"))).toBe(true);
  });

  it("SEARCH ブロックが EOF まで閉じられない", () => {
    const msgs = issuesOf(
      doc("## CHANGES", "概要", "### FILE: a.ts (replace)", "<<<<<<< SEARCH", "old"),
    );
    expect(msgs.some((m) => m.includes("閉じられていません"))).toBe(true);
  });

  it("======= がないまま >>>>>>> REPLACE", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "old",
        ">>>>>>> REPLACE",
      ),
    );
    expect(msgs.some((m) => m.includes("======="))).toBe(true);
  });

  it("======= が 1 ブロックに複数", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        "=======",
        ">>>>>>> REPLACE",
      ),
    );
    expect(msgs.some((m) => m.includes("複数あります"))).toBe(true);
  });

  it("SEARCH 中に次の SEARCH (ネスト)", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        ">>>>>>> REPLACE",
      ),
    );
    expect(msgs.some((m) => m.includes("次の <<<<<<< SEARCH"))).toBe(true);
  });

  it("REPLACE 中に次の SEARCH (閉じ忘れ) は報告しつつ次ブロックを拾う", () => {
    const result = parseChanges(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        "<<<<<<< SEARCH",
        "two",
        "=======",
        "TWO",
        ">>>>>>> REPLACE",
      ),
    );
    expect(result.issues.some((i) => i.message.includes("閉じられないまま"))).toBe(true);
    const rep = result.changeSet.files[0] as ReplaceFileChange;
    expect(rep.blocks).toHaveLength(1);
    expect(rep.blocks[0]?.search).toEqual(["two"]);
  });

  it("SEARCH ブロックが空", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "<<<<<<< SEARCH",
        "=======",
        "new",
        ">>>>>>> REPLACE",
      ),
    );
    expect(msgs.some((m) => m.includes("SEARCH ブロックが空"))).toBe(true);
  });

  it("replace 指定なのにブロックがない", () => {
    const msgs = issuesOf(doc("## CHANGES", "概要", "### FILE: a.ts (replace)"));
    expect(msgs.some((m) => m.includes("ブロックがありません"))).toBe(true);
  });

  it("create 指定なのに CONTENT ブロックがない", () => {
    const msgs = issuesOf(doc("## CHANGES", "概要", "### FILE: a.ts (create)"));
    expect(msgs.some((m) => m.includes("CONTENT ブロックがありません"))).toBe(true);
  });

  it("CONTENT ブロックが EOF まで閉じられない", () => {
    const msgs = issuesOf(
      doc("## CHANGES", "概要", "### FILE: a.ts (create)", "<<<<<<< CONTENT", "body"),
    );
    expect(msgs.some((m) => m.includes(">>>>>>> END で閉じられていません"))).toBe(true);
  });

  it("CONTENT ブロックが複数", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (create)",
        "<<<<<<< CONTENT",
        "one",
        ">>>>>>> END",
        "<<<<<<< CONTENT",
        "two",
        ">>>>>>> END",
      ),
    );
    expect(msgs.some((m) => m.includes("CONTENT ブロックが複数"))).toBe(true);
  });

  it("delete 指定に本文がある", () => {
    const msgs = issuesOf(
      doc("## CHANGES", "概要", "### FILE: a.ts (delete)", "余計な本文"),
    );
    expect(msgs.some((m) => m.includes("delete 指定に本文は書けません"))).toBe(true);
  });

  it("ブロック外に地の文 (AI の解説混入)", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (replace)",
        "この変更では次のようにします。",
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        ">>>>>>> REPLACE",
      ),
    );
    expect(msgs.some((m) => m.includes("予期しない行"))).toBe(true);
  });

  it("同一パスの FILE セクションが重複", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.ts (delete)",
        "### FILE: a.ts (create)",
        "<<<<<<< CONTENT",
        "x",
        ">>>>>>> END",
      ),
    );
    expect(msgs.some((m) => m.includes("複数あります"))).toBe(true);
  });

  it("最初の FILE 行より前にマーカー (FILE 行の破損検出)", () => {
    const msgs = issuesOf(
      doc(
        "## CHANGES",
        "概要",
        "## FILE: a.ts (replace)", // # が 2 個 → FILE 行と認識されない
        "<<<<<<< SEARCH",
        "old",
        "=======",
        "new",
        ">>>>>>> REPLACE",
      ),
    );
    expect(msgs.some((m) => m.includes("FILE 行より前に現れました"))).toBe(true);
  });

  it("CHANGES 本文が空", () => {
    const msgs = issuesOf(doc("## CHANGES", "### FILE: a.ts (delete)"));
    expect(msgs.some((m) => m.includes("変更概要"))).toBe(true);
  });

  it("FILE セクションが 1 つもない", () => {
    const msgs = issuesOf(doc("## CHANGES", "概要だけ"));
    expect(msgs.some((m) => m.includes("FILE セクションが 1 つもありません"))).toBe(true);
  });

  it("issue の行番号が changes.md の実行番号を指す", () => {
    const { issues } = parseChanges(
      doc(
        "## CHANGES", // 1
        "概要", // 2
        "### FILE: a.ts (replace)", // 3
        "<<<<<<< SEARCH", // 4
        "old", // 5
      ),
    );
    expect(issues[0]?.line).toBe(4);
  });
});
