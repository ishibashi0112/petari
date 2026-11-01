/**
 * initConfig(--init-config)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { EXAMPLE_CONFIG, initConfig, type InitConfigDeps } from "../../src/pack/initConfig.ts";

const ROOT = path.resolve("/work/tsproj");

interface FakeFs {
  deps: InitConfigDeps;
  files: Map<string, string>;
}

/** dirs: ルート相対のディレクトリ名。files: ルート直下のファイル名(内容は空) */
function fakeFs(dirs: string[], files: string[] = []): FakeFs {
  const fileMap = new Map(files.map((name) => [path.join(ROOT, name), ""]));
  const dirSet = new Set([ROOT, ...dirs.map((d) => path.join(ROOT, d))]);
  return {
    files: fileMap,
    deps: {
      isDirectory: (p) => dirSet.has(path.resolve(p)),
      isFile: (p) => fileMap.has(path.resolve(p)),
      listFileNames: (p) =>
        path.resolve(p) === ROOT
          ? [...fileMap.keys()].map((k) => path.basename(k))
          : undefined,
      writeTextFile: (p, content) => {
        fileMap.set(path.resolve(p), content);
      },
    },
  };
}

suite("initConfig", () => {
  test("src と tests があれば両方を extraRoots に書く(kind は src / test)", () => {
    const fs = fakeFs(["src", "tests", "node_modules", "dist"], ["package.json"]);
    const result = initConfig(ROOT, fs.deps);
    assert.strictEqual(result.kind, "created");
    if (result.kind !== "created") return;
    assert.strictEqual(result.path, path.join(ROOT, "tazuna.config.json"));
    assert.deepStrictEqual(result.roots, [
      { path: "src", kind: "src" },
      { path: "tests", kind: "test" },
    ]);
    assert.deepStrictEqual(JSON.parse(result.content), {
      kind: "generic",
      extraRoots: [
        { path: "src", kind: "src" },
        { path: "tests", kind: "test" },
      ],
    });
    assert.strictEqual(fs.files.get(path.join(ROOT, "tazuna.config.json")), result.content);
    assert.ok(result.content.endsWith("}\n"), "末尾は改行で終える");
  });

  test("候補は実在するものだけ(src のみなら test は書かない)", () => {
    const result = initConfig(ROOT, fakeFs(["src"]).deps);
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(result.roots, [{ path: "src", kind: "src" }]);
  });

  test("複数の候補(app と e2e)も拾う。順序は候補名の順", () => {
    const result = initConfig(ROOT, fakeFs(["e2e", "app", "lib"]).deps);
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(result.roots, [
      { path: "app", kind: "src" },
      { path: "lib", kind: "src" },
      { path: "e2e", kind: "test" },
    ]);
  });

  test("既に旧名の slnmix.config.json があれば変えない(冪等。新しい名前の設定も作らない)", () => {
    const fs = fakeFs(["src"], ["slnmix.config.json"]);
    fs.files.set(path.join(ROOT, "slnmix.config.json"), '{ "kind": "solution" }');
    const result = initConfig(ROOT, fs.deps);
    assert.deepStrictEqual(result, { kind: "kept", path: path.join(ROOT, "slnmix.config.json") });
    assert.strictEqual(fs.files.get(path.join(ROOT, "slnmix.config.json")), '{ "kind": "solution" }');
  });

  test(".sln / .vbproj がある場所では作らない(solution 構成で動くため)", () => {
    const fs = fakeFs(["src"], ["App.sln", "readme.txt"]);
    const result = initConfig(ROOT, fs.deps);
    assert.ok(result.kind === "error" && result.message.includes("App.sln"));
    assert.ok(!fs.files.has(path.join(ROOT, "slnmix.config.json")));
  });

  test("ソースの候補ディレクトリが無ければ推測で書かずエラー + 設定例", () => {
    const fs = fakeFs(["docs", "tests"]);
    const result = initConfig(ROOT, fs.deps);
    assert.ok(result.kind === "error");
    assert.ok(result.message.includes("見つかりません"));
    assert.ok(result.message.includes(EXAMPLE_CONFIG));
    assert.ok(!fs.files.has(path.join(ROOT, "slnmix.config.json")));
  });
});
