/**
 * contractSummary の単体テスト。hybrid fixture の contract.schema.json
 * (webview2-bridge の gen が出したもの)を正として検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderType, summarizeContractSchema } from "../../src/pack/services/contractSummary.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

suite("contractSummary: summarizeContractSchema", () => {
  const schemaText = fs.readFileSync(
    path.join(FIXTURES_ROOT, "hybrid", "contract", "contract.schema.json"),
    "utf8",
  );

  test("methods / events / types を一覧にする", () => {
    const result = summarizeContractSchema(schemaText);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.lines, [
      "methods:",
      "- parts.search(input: { keyword: string; limit?: integer }) -> { items: Part[] }",
      "events:",
      "- progress(payload: { percent: number; message?: string })",
      "types:",
      "- Part { partNo: string; name: string; qty: integer; updatedAt: string(ISO 8601) }",
    ]);
    assert.strictEqual(result.methodCount, 1);
    assert.strictEqual(result.eventCount, 1);
    assert.strictEqual(result.typeCount, 1);
  });

  test("contractVersion が未知なら要約せず理由を返す", () => {
    const result = summarizeContractSchema(JSON.stringify({ contractVersion: 2, methods: {} }));
    assert.ok(!result.ok);
    assert.ok(result.reason.includes("contractVersion: 2"));
  });

  test("contractVersion がなければ未知の形式", () => {
    const result = summarizeContractSchema(JSON.stringify({ methods: {} }));
    assert.ok(!result.ok && result.reason.includes("なし"));
  });

  test("JSON でなければ理由付きで失敗(クラッシュしない)", () => {
    const result = summarizeContractSchema("not json");
    assert.ok(!result.ok && result.reason.includes("JSON"));
  });

  test("空の契約は (なし) を書く", () => {
    const result = summarizeContractSchema(JSON.stringify({ contractVersion: 1 }));
    assert.ok(result.ok);
    assert.deepStrictEqual(result.lines, [
      "methods:",
      "(なし)",
      "events:",
      "(なし)",
      "types:",
      "(なし)",
    ]);
  });
});

suite("contractSummary: renderType", () => {
  test("$ref は $defs の名前に、それ以外の参照は unknown に", () => {
    assert.strictEqual(renderType({ $ref: "#/$defs/Part" }), "Part");
    assert.strictEqual(renderType({ $ref: "#/other" }), "unknown(#/other)");
  });

  test("配列・enum・union・null 許容", () => {
    assert.strictEqual(renderType({ type: "array", items: { type: "string" } }), "string[]");
    assert.strictEqual(
      renderType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } }),
      "(string | null)[]",
    );
    assert.strictEqual(renderType({ enum: ["a", "b"] }), '"a" | "b"');
    assert.strictEqual(renderType({ type: ["string", "null"] }), "string | null");
    assert.strictEqual(renderType({ const: 1 }), "1");
  });

  test("Record と深い入れ子の打ち切り", () => {
    assert.strictEqual(
      renderType({ type: "object", additionalProperties: { type: "number" } }),
      "Record<string, number>",
    );
    const deep = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "string" } } } } },
      },
    };
    assert.strictEqual(renderType(deep), "{ a?: { b?: {...} } }");
  });

  test("解釈できない形は unknown(推測しない)", () => {
    assert.strictEqual(renderType({}), "unknown");
    assert.strictEqual(renderType("string"), "unknown");
  });
});
