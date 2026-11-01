/**
 * slnmixConfig の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import {
  defaultIncludeFor,
  loadSlnmixConfig,
  normalizeRootRelative,
  type SlnmixConfigDeps,
} from "../../src/pack/slnmixConfig.ts";

const ROOT = path.resolve("/work/repo");

function fakeDeps(files: Record<string, string>): SlnmixConfigDeps {
  const map = new Map(
    Object.entries(files).map(([p, content]) => [path.resolve(ROOT, p), content]),
  );
  return { readTextFile: (p) => map.get(path.resolve(p)) };
}

suite("slnmixConfig: 設定なし", () => {
  test("ファイルがなければ空の設定(エラーにしない)", () => {
    const result = loadSlnmixConfig(ROOT, fakeDeps({}));
    assert.deepStrictEqual(result.config, {
      kind: "solution",
      extraRoots: [],
      generatedDirs: [],
      sources: [],
      contractSchema: undefined,
      contractFile: undefined,
    });
    assert.deepStrictEqual(result.diagnostics, []);
  });
});

suite("slnmixConfig: 新しい名前(petari.config.json)と旧名(slnmix.config.json)", () => {
  test("petari.config.json を読む(出どころと診断の名前はそのファイル)", () => {
    const result = loadSlnmixConfig(ROOT, fakeDeps({ "petari.config.json": JSON.stringify({ kind: "typescript" }) }));
    assert.deepStrictEqual(result.config.sources, ["petari.config.json"]);
    assert.ok(result.diagnostics.some((d) => d.message.startsWith("petari.config.json: kind は")));
    assert.strictEqual(result.conflict, undefined);
  });

  test("旧名の診断は旧名で出す", () => {
    const result = loadSlnmixConfig(ROOT, fakeDeps({ "slnmix.config.json": JSON.stringify({ kind: "typescript" }) }));
    assert.ok(result.diagnostics.some((d) => d.message.startsWith("slnmix.config.json: kind は")));
  });

  test("両方あれば設定なしとして conflict を返す(呼び出し側が止める)", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "petari.config.json": '{ "kind": "generic" }', "slnmix.config.json": "{}" }),
    );
    assert.strictEqual(result.config.kind, "solution");
    assert.deepStrictEqual(result.config.sources, []);
    assert.ok(result.conflict !== undefined && result.conflict.includes("両方あります"));
  });
});

suite("slnmixConfig: slnmix.config.json", () => {
  test("extraRoots を読み、include 省略時は kind ごとの既定を使う", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({
        "slnmix.config.json": JSON.stringify({
          extraRoots: [
            { path: "apps/web/", kind: "web" },
            { path: "./contract", kind: "contract", include: ["contract.ts"], exclude: ["x/**"] },
            { path: "docs", kind: "docs" },
          ],
          contractSchema: "contract/contract.schema.json",
          generatedDirs: ["dotnet/Gen/", "apps/web/src/generated"],
        }),
      }),
    );
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(result.config.sources, ["slnmix.config.json"]);
    assert.deepStrictEqual(result.config.extraRoots, [
      { path: "apps/web", kind: "web", include: defaultIncludeFor("web"), exclude: [] },
      { path: "contract", kind: "contract", include: ["contract.ts"], exclude: ["x/**"] },
      { path: "docs", kind: "docs", include: ["**/*"], exclude: [] },
    ]);
    assert.strictEqual(result.config.contractSchema, "contract/contract.schema.json");
    assert.deepStrictEqual(result.config.generatedDirs, [
      "dotnet/Gen",
      "apps/web/src/generated",
    ]);
  });

  test("壊れた JSON は警告して設定なしとして続行する", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": "{ extraRoots: [" }),
    );
    assert.deepStrictEqual(result.config.extraRoots, []);
    assert.ok(result.diagnostics.some((d) => d.severity === "warning"));
  });

  test("不正な要素は個別に警告して飛ばす(残りは使う)", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({
        "slnmix.config.json": JSON.stringify({
          extraRoots: [
            { kind: "web" },
            { path: "../outside", kind: "web" },
            { path: "/abs", kind: "web" },
            "文字列",
            { path: "ok", kind: "web", include: "not-array" },
          ],
          generatedDirs: "not-array",
        }),
      }),
    );
    assert.deepStrictEqual(
      result.config.extraRoots.map((r) => r.path),
      ["ok"],
    );
    assert.strictEqual(result.diagnostics.length, 6);
  });
});

suite("slnmixConfig: webview2-bridge.gen.json の自動検出", () => {
  const gen = JSON.stringify({
    contract: "contract/contract.ts",
    schemaOut: "contract/contract.schema.json",
    ts: { outDir: "apps/web/src/generated" },
    vb: { outDir: "dotnet/App.Contract/Generated" },
  });

  test("gen.json だけでも contractSchema / contractFile / generatedDirs が埋まる", () => {
    const result = loadSlnmixConfig(ROOT, fakeDeps({ "webview2-bridge.gen.json": gen }));
    assert.deepStrictEqual(result.config.sources, ["webview2-bridge.gen.json"]);
    assert.strictEqual(result.config.contractSchema, "contract/contract.schema.json");
    assert.strictEqual(result.config.contractFile, "contract/contract.ts");
    assert.deepStrictEqual(result.config.generatedDirs, [
      "dotnet/App.Contract/Generated",
      "apps/web/src/generated",
    ]);
  });

  test("slnmix.config.json の明示指定が gen.json より優先する", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({
        "webview2-bridge.gen.json": gen,
        "slnmix.config.json": JSON.stringify({
          contractSchema: "other/schema.json",
          generatedDirs: ["only/this"],
        }),
      }),
    );
    assert.deepStrictEqual(result.config.sources, [
      "slnmix.config.json",
      "webview2-bridge.gen.json",
    ]);
    assert.strictEqual(result.config.contractSchema, "other/schema.json");
    assert.strictEqual(result.config.contractFile, "contract/contract.ts");
    assert.deepStrictEqual(result.config.generatedDirs, ["only/this"]);
  });

  test("壊れた gen.json は警告して無視する", () => {
    const result = loadSlnmixConfig(ROOT, fakeDeps({ "webview2-bridge.gen.json": "{" }));
    assert.strictEqual(result.config.contractSchema, undefined);
    assert.ok(result.diagnostics.some((d) => d.message.includes("webview2-bridge.gen.json")));
  });

  test("normalizeRootRelative: 区切りを / にし、先頭 ./ と末尾 / を落とす", () => {
    assert.strictEqual(normalizeRootRelative(".\\apps\\web\\"), "apps/web");
  });

  test("kind: \"test\" の include 既定は **/*.{ts,tsx,json,md}(テスト戦略メモ §7-3)", () => {
    assert.deepStrictEqual(defaultIncludeFor("test"), ["**/*.{ts,tsx,json,md}"]);
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({
        "slnmix.config.json": JSON.stringify({
          extraRoots: [{ path: "e2e", kind: "test" }],
        }),
      }),
    );
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(result.config.extraRoots, [
      { path: "e2e", kind: "test", include: ["**/*.{ts,tsx,json,md}"], exclude: [] },
    ]);
    // 既定は毎回コピーを返す(呼び出し側が書き換えても既定は変わらない)
    defaultIncludeFor("test").push("x");
    assert.deepStrictEqual(defaultIncludeFor("test"), ["**/*.{ts,tsx,json,md}"]);
  });
});

suite("slnmixConfig: docs(フェーズ 6)", () => {
  test("docs がなければ undefined(連携なし)", () => {
    const { config } = loadSlnmixConfig(ROOT, fakeDeps({ "slnmix.config.json": "{}" }));
    assert.strictEqual(config.docs, undefined);
  });

  test("docs: true は既定配置", () => {
    const { config, diagnostics } = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": '{ "docs": true }' }),
    );
    assert.deepStrictEqual(config.docs, {
      design: "docs/design",
      spec: "docs/spec",
      handoff: "docs/HANDOFF.md",
    });
    assert.deepStrictEqual(diagnostics, []);
  });

  test("オブジェクトは各キーを既定に重ね、区切りを正規化する", () => {
    const { config } = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": '{ "docs": { "design": "./doc/設計/", "handoff": "doc/H.md" } }' }),
    );
    assert.deepStrictEqual(config.docs, {
      design: "doc/設計",
      spec: "docs/spec",
      handoff: "doc/H.md",
    });
  });

  test("ルート外・絶対パス・非文字列は警告して既定に戻す", () => {
    const { config, diagnostics } = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": '{ "docs": { "design": "../x", "spec": 1 } }' }),
    );
    assert.deepStrictEqual(config.docs, {
      design: "docs/design",
      spec: "docs/spec",
      handoff: "docs/HANDOFF.md",
    });
    assert.strictEqual(diagnostics.length, 2);
  });

  test("docs が文字列など不正な型なら警告して連携なし", () => {
    const { config, diagnostics } = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": '{ "docs": "docs" }' }),
    );
    assert.strictEqual(config.docs, undefined);
    assert.strictEqual(diagnostics.length, 1);
  });
});

suite("slnmixConfig: target", () => {
  test("ルート相対の .sln を読む(/ 区切りに正規化)", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": JSON.stringify({ target: "dotnet\\\\App.sln" }) }),
    );
    assert.strictEqual(result.config.target, "dotnet/App.sln");
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test("無ければ target キーを持たない", () => {
    const result = loadSlnmixConfig(ROOT, fakeDeps({ "slnmix.config.json": "{}" }));
    assert.ok(!("target" in result.config));
  });

  test("文字列以外・ルート外・拡張子違いは警告して無視", () => {
    for (const [target, fragment] of [
      [123, "文字列で"],
      ["../other/App.sln", "ルート配下"],
      ["/abs/App.sln", "ルート配下"],
      ["dotnet/readme.txt", ".sln / .vbproj"],
    ] as const) {
      const result = loadSlnmixConfig(
        ROOT,
        fakeDeps({ "slnmix.config.json": JSON.stringify({ target }) }),
      );
      assert.strictEqual(result.config.target, undefined, String(target));
      assert.ok(result.diagnostics.some((d) => d.message.includes(fragment)), String(target));
    }
  });
});

suite("slnmixConfig: kind(generic 構成。v0.17.0)", () => {
  test("省略時は solution", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": JSON.stringify({ extraRoots: [{ path: "src" }] }) }),
    );
    assert.strictEqual(result.config.kind, "solution");
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test("設定ファイル自体が無くても solution", () => {
    assert.strictEqual(loadSlnmixConfig(ROOT, fakeDeps({})).config.kind, "solution");
  });

  test('"generic" を読む(extraRoots あり。診断なし)', () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({
        "slnmix.config.json": JSON.stringify({
          kind: "generic",
          extraRoots: [{ path: "src", kind: "src" }],
        }),
      }),
    );
    assert.strictEqual(result.config.kind, "generic");
    assert.deepStrictEqual(result.config.extraRoots.map((r) => r.path), ["src"]);
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test("不正な値は警告して solution(既定)に戻す", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "slnmix.config.json": JSON.stringify({ kind: "typescript" }) }),
    );
    assert.strictEqual(result.config.kind, "solution");
    assert.ok(result.diagnostics.some((d) => d.message.includes("kind は")));
  });

  test("generic で target があれば無視して警告", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({
        "slnmix.config.json": JSON.stringify({
          kind: "generic",
          target: "dotnet/App.sln",
          extraRoots: [{ path: "src" }],
        }),
      }),
    );
    assert.strictEqual(result.config.kind, "generic");
    assert.ok(!("target" in result.config));
    assert.ok(result.diagnostics.some((d) => d.message.includes("target は使いません")));
  });

  test("generic で extraRoots が無くても警告しない(git が管理しているファイルが対象。設計書 §25.7)", () => {
    const result = loadSlnmixConfig(
      ROOT,
      fakeDeps({ "petari.config.json": JSON.stringify({ kind: "generic" }) }),
    );
    assert.strictEqual(result.config.kind, "generic");
    assert.deepStrictEqual(result.config.extraRoots, []);
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test('kind: "src" の include 既定は TS / JS / スタイル / JSON / HTML / Markdown', () => {
    assert.deepStrictEqual(defaultIncludeFor("src"), [
      "**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,json,html,md}",
    ]);
  });
});
