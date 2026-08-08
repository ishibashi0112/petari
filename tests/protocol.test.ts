import { describe, expect, it } from "vitest";
import { PROTOCOL_TEXT, PROTOCOL_VERSION } from "../src/assets/protocol.ts";
import { parseChanges } from "../src/core/parser.ts";

describe("規約文 (§4.5)", () => {
  it("バージョン識別子を含む", () => {
    expect(PROTOCOL_TEXT).toContain(`petari protocol v${PROTOCOL_VERSION}`);
  });

  it("規約の必須要素をすべて説明している", () => {
    for (const marker of [
      "## CHANGES",
      "### FILE:",
      "<<<<<<< SEARCH",
      "=======",
      ">>>>>>> REPLACE",
      "<<<<<<< CONTENT",
      ">>>>>>> END",
      "replace",
      "create",
      "rewrite",
      "delete",
      "rename",
      "一意",
      "Shift_JIS",
      "Mermaid",
    ]) {
      expect(PROTOCOL_TEXT).toContain(marker);
    }
  });

  it("規約文中のサンプル changes.md はパーサで実際に解釈できる", () => {
    // コードフェンス内の例 (## CHANGES 〜 ``` まで) を取り出してパースする
    const fence = PROTOCOL_TEXT.split("```")[1] ?? "";
    const { changeSet, issues } = parseChanges(fence);
    expect(issues).toEqual([]);
    expect(changeSet.files.map((f) => f.op)).toEqual(["replace", "create", "rewrite", "delete"]);
  });

  it("smoke: petari protocol が 0 で終了する", async () => {
    const { protocolCommand } = await import("../src/commands/protocol.ts");
    expect(await protocolCommand([])).toBe(0);
  });
});
