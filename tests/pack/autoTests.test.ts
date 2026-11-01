/**
 * 自動テストの有無の判定(autoTests)の単体テスト。
 * 手順文 v6 の「自動テスト」の節を入れるかどうかは、この判定だけで決まる。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import { describeAutoTests, detectAutoTests, isAutoTestPath } from "../../src/pack/autoTests.ts";

suite("autoTests: isAutoTestPath", () => {
  test("e2e/ で始まる、または /e2e/ を含むパス", () => {
    assert.ok(isAutoTestPath("e2e/screen/order.spec.ts"));
    assert.ok(isAutoTestPath("e2e/fixtures/db.ts"));
    assert.ok(isAutoTestPath("apps/web/e2e/api/parts.spec.ts"));
    assert.ok(isAutoTestPath("apps\\web\\e2e\\host\\order.spec.ts"), "区切りが \\ でも同じ");
  });

  test("末尾が .spec.ts / .spec.tsx / .test.ts / .test.tsx", () => {
    assert.ok(isAutoTestPath("apps/web/src/format.test.ts"));
    assert.ok(isAutoTestPath("apps/web/src/Order.test.tsx"));
    assert.ok(isAutoTestPath("tests/order.spec.ts"));
    assert.ok(isAutoTestPath("tests/Order.spec.tsx"));
    assert.ok(isAutoTestPath("Tests/Order.Spec.TS"), "大文字小文字は区別しない");
  });

  test("該当しないパス(e2e という名前を含むだけ、拡張子違い、VB)", () => {
    assert.ok(!isAutoTestPath("App/Forms/OrderForm.vb"));
    assert.ok(!isAutoTestPath("apps/web/src/App.tsx"));
    assert.ok(!isAutoTestPath("apps/web/src/e2e-helper.ts"), "e2e/ というディレクトリではない");
    assert.ok(!isAutoTestPath("me2e/x.ts"));
    assert.ok(!isAutoTestPath("apps/web/src/spec.ts"));
    assert.ok(!isAutoTestPath("apps/web/src/order.test.js"), ".js は対象外");
    assert.ok(!isAutoTestPath("apps/web/src/order.spec.ts.bak"));
  });
});

suite("autoTests: detectAutoTests", () => {
  test("パックにも extraRoots にも無ければ「なし」(旧 WinForms のみのプロジェクト)", () => {
    const result = detectAutoTests(
      ["App/Forms/OrderForm.vb", "App/Module1.vb", "App/App.config"],
      [{ kind: "web" }, { kind: "contract" }],
    );
    assert.deepStrictEqual(result, { present: false, matchedPaths: [], testRoot: false });
    assert.strictEqual(describeAutoTests(result), "なし");
  });

  test("パック内のテストファイルで「あり」。一致したパスを出力順に持つ", () => {
    const result = detectAutoTests(
      [
        "App/Forms/OrderForm.vb",
        "apps/web/src/App.tsx",
        "apps/web/src/format.test.ts",
        "e2e/screen/order.spec.ts",
      ],
      [{ kind: "web" }],
    );
    assert.strictEqual(result.present, true);
    assert.deepStrictEqual(result.matchedPaths, [
      "apps/web/src/format.test.ts",
      "e2e/screen/order.spec.ts",
    ]);
    assert.strictEqual(result.testRoot, false);
    assert.strictEqual(
      describeAutoTests(result),
      "あり(パック内に apps/web/src/format.test.ts ほか 1 件)",
    );
  });

  test("extraRoots の kind: \"test\" だけでも「あり」(ディレクトリが空でも意識づけはする)", () => {
    const result = detectAutoTests(["App/Module1.vb"], [{ kind: "web" }, { kind: "test" }]);
    assert.deepStrictEqual(result, { present: true, matchedPaths: [], testRoot: true });
    assert.strictEqual(describeAutoTests(result), 'あり(extraRoots に kind: "test")');
  });

  test("両方あれば理由を併記。1 件なら「ほか」を付けない", () => {
    const result = detectAutoTests(["e2e/api/parts.spec.ts"], [{ kind: "test" }]);
    assert.strictEqual(
      describeAutoTests(result),
      'あり(パック内に e2e/api/parts.spec.ts / extraRoots に kind: "test")',
    );
  });

  test("kind は完全一致(tests / Test は対象外。推測しない)", () => {
    assert.strictEqual(detectAutoTests([], [{ kind: "tests" }]).present, false);
    assert.strictEqual(detectAutoTests([], [{ kind: "Test" }]).present, false);
  });
});
