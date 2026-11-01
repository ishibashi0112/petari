/**
 * designerFileFilter の単体テスト(CLI 固有・共有コア外)。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import { buildDesignerFileMatcher } from "../../src/pack/designerFileFilter.ts";

suite("designerFileFilter: buildDesignerFileMatcher", () => {
  test("ファイル名の全体一致で含める(パスが違っても一致)", () => {
    const matcher = buildDesignerFileMatcher(["OrderForm.Designer.vb"]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), true);
    assert.strictEqual(matcher("OrderForm.Designer.vb"), true);
    assert.strictEqual(matcher("Forms\\OtherForm.Designer.vb"), false);
  });

  test("論理パスの全体一致でも含める", () => {
    const matcher = buildDesignerFileMatcher(["Forms\\OrderForm.Designer.vb"]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), true);
    assert.strictEqual(matcher("Sub\\Forms\\OrderForm.Designer.vb"), false);
  });

  test("大文字小文字は区別しない(Windows のファイル名前提)", () => {
    const matcher = buildDesignerFileMatcher(["orderform.designer.vb"]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), true);
  });

  test("* は任意の文字列にマッチする", () => {
    const matcher = buildDesignerFileMatcher(["Order*"]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), true);
    assert.strictEqual(matcher("Forms\\OrderForm.resx"), true);
    assert.strictEqual(matcher("My Project\\Application.Designer.vb"), false);
  });

  test("部分一致では含めない(前方一致には * が必要)", () => {
    const matcher = buildDesignerFileMatcher(["OrderForm"]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), false);
  });

  test("パターンの / は \\ として扱う", () => {
    const matcher = buildDesignerFileMatcher(["Forms/OrderForm.Designer.vb"]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), true);
  });

  test("複数パターンはいずれかに一致すれば含める", () => {
    const matcher = buildDesignerFileMatcher([
      "OrderForm.Designer.vb",
      "Application.*",
    ]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), true);
    assert.strictEqual(matcher("My Project\\Application.Designer.vb"), true);
    assert.strictEqual(matcher("Forms\\OtherForm.Designer.vb"), false);
  });

  test("正規表現のメタ文字はそのままの文字として扱う", () => {
    const matcher = buildDesignerFileMatcher(["Form(1).Designer.vb"]);
    assert.strictEqual(matcher("Form(1).Designer.vb"), true);
    assert.strictEqual(matcher("Form1x.Designer.vb"), false);
  });

  test("パターンが空なら何も含めない", () => {
    const matcher = buildDesignerFileMatcher([]);
    assert.strictEqual(matcher("Forms\\OrderForm.Designer.vb"), false);
  });
});
