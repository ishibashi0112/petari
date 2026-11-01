/**
 * rootResolver の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { isWithinDirectory, resolveRoot, type RootResolverDeps } from "../../src/pack/rootResolver.ts";

const CWD = path.resolve("/work/app");
const TARGET = path.join(CWD, "dotnet", "App.sln");

/** files: 存在するファイルの絶対パス、dirs: 存在するディレクトリの絶対パス */
function fakeDeps(files: string[], dirs: string[]): RootResolverDeps {
  const fileSet = new Set(files.map((p) => path.resolve(p)));
  const dirSet = new Set(dirs.map((p) => path.resolve(p)));
  return {
    isFile: (p) => fileSet.has(path.resolve(p)),
    isDirectory: (p) => dirSet.has(path.resolve(p)),
    exists: (p) => fileSet.has(path.resolve(p)) || dirSet.has(path.resolve(p)),
  };
}

suite("rootResolver: 既定(設定ファイルなし)", () => {
  test("入力のディレクトリがルート(従来どおり)", () => {
    const deps = fakeDeps([], [CWD, path.join(CWD, "dotnet")]);
    assert.deepStrictEqual(resolveRoot(TARGET, undefined, CWD, deps), {
      kind: "root",
      rootDir: path.join(CWD, "dotnet"),
      reason: "target",
    });
  });

  test("入力のディレクトリに設定があればそこ(従来どおり)", () => {
    const deps = fakeDeps([path.join(CWD, "dotnet", "slnmix.config.json"), path.join(CWD, "slnmix.config.json")], [CWD]);
    assert.deepStrictEqual(resolveRoot(TARGET, undefined, CWD, deps), {
      kind: "root",
      rootDir: path.join(CWD, "dotnet"),
      reason: "target",
    });
  });
});

suite("rootResolver: 上位の slnmix.config.json", () => {
  test("上のディレクトリに設定があればそこがルート", () => {
    const deps = fakeDeps([path.join(CWD, "slnmix.config.json")], [CWD]);
    assert.deepStrictEqual(resolveRoot(TARGET, undefined, CWD, deps), {
      kind: "root",
      rootDir: CWD,
      reason: "config",
    });
  });

  test(".git のあるディレクトリより上には行かない", () => {
    const deps = fakeDeps([path.resolve("/work/slnmix.config.json")], [CWD, path.join(CWD, ".git")]);
    assert.deepStrictEqual(resolveRoot(TARGET, undefined, CWD, deps), {
      kind: "root",
      rootDir: path.join(CWD, "dotnet"),
      reason: "target",
    });
  });

  test(".git と同じディレクトリの設定は使う", () => {
    const deps = fakeDeps([path.join(CWD, "slnmix.config.json")], [CWD, path.join(CWD, ".git")]);
    const result = resolveRoot(TARGET, undefined, CWD, deps);
    assert.ok(result.kind === "root" && result.rootDir === CWD && result.reason === "config");
  });
});

suite("rootResolver: --root", () => {
  test("明示指定はそれを使う(相対は cwd 基準)", () => {
    const deps = fakeDeps([], [CWD, path.join(CWD, "dotnet")]);
    assert.deepStrictEqual(resolveRoot(TARGET, ".", CWD, deps), {
      kind: "root",
      rootDir: CWD,
      reason: "explicit",
    });
  });

  test("存在しないディレクトリはエラー", () => {
    const deps = fakeDeps([], [CWD]);
    const result = resolveRoot(TARGET, "nope", CWD, deps);
    assert.ok(result.kind === "error" && result.message.includes("--root のディレクトリがありません"));
  });

  test("入力がルートの外ならエラー", () => {
    const other = path.resolve("/work/other");
    const deps = fakeDeps([], [CWD, other]);
    const result = resolveRoot(TARGET, other, CWD, deps);
    assert.ok(result.kind === "error" && result.message.includes("配下にありません"));
  });
});

suite("rootResolver: isWithinDirectory", () => {
  test("同じ・配下・外", () => {
    assert.strictEqual(isWithinDirectory(CWD, CWD), true);
    assert.strictEqual(isWithinDirectory(CWD, path.join(CWD, "a", "b")), true);
    assert.strictEqual(isWithinDirectory(CWD, path.resolve("/work/other")), false);
  });
});
