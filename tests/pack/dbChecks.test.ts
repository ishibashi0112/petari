/**
 * dbChecks(AI チャットだけでの DB 確認)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { describeDbSchema, renderDbSchemaBlock, resolveDbSchema } from "../../src/pack/dbChecks.ts";

const ROOT = path.resolve("/work/project");

suite("dbChecks", () => {
  test("ルートの docs/db/schema.md があれば読み、なければ undefined", () => {
    const file = path.resolve(ROOT, "docs", "db", "schema.md");
    const found = resolveDbSchema(ROOT, { readTextFile: (p) => (p === file ? "# DB\n" : undefined) });
    assert.deepStrictEqual(found, { relativePath: "docs/db/schema.md", content: "# DB\n" });
    assert.strictEqual(resolveDbSchema(ROOT, { readTextFile: () => undefined }), undefined);
  });

  test("<db_schema> ブロック: path 属性・説明の 1 行・本文(末尾の改行は 1 つ)", () => {
    assert.strictEqual(
      renderDbSchemaBlock({ relativePath: "docs/db/schema.md", content: "# DB\n\n### dbo.orders\n" }),
      '<db_schema path="docs/db/schema.md">\nテスト用 DB のテーブル定義(ashiato schema の出力。行の値は含まない)。確認用の SQL はこの定義に合わせて書く。\n\n# DB\n\n### dbo.orders\n</db_schema>\n',
    );
  });

  test("表示: あり(文字数)/ なし", () => {
    assert.strictEqual(describeDbSchema({ relativePath: "docs/db/schema.md", content: "x".repeat(1234) }), "あり(docs/db/schema.md、1,234 文字)");
    assert.strictEqual(describeDbSchema(undefined), "なし(docs/db/schema.md がありません)");
  });
});
