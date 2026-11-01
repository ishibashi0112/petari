/**
 * initDocs(--init-docs)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { DOCS_README } from "../../src/pack/assets/docTemplates.ts";
import { initDocs, type InitDocsDeps } from "../../src/pack/initDocs.ts";

const ROOT = path.resolve("/work/repo");

interface FakeFs {
  deps: InitDocsDeps;
  files: Map<string, string>;
  dirs: Set<string>;
}

function fakeFs(files: Record<string, string> = {}, dirs: string[] = []): FakeFs {
  const fileMap = new Map(
    Object.entries(files).map(([p, c]) => [path.resolve(ROOT, p), c]),
  );
  const dirSet = new Set(dirs.map((d) => path.resolve(ROOT, d)));
  return {
    files: fileMap,
    dirs: dirSet,
    deps: {
      exists: (p) => fileMap.has(path.resolve(p)) || dirSet.has(path.resolve(p)),
      readTextFile: (p) => fileMap.get(path.resolve(p)),
      writeTextFile: (p, content) => {
        fileMap.set(path.resolve(p), content);
      },
      makeDirectory: (p) => {
        dirSet.add(path.resolve(p));
      },
    },
  };
}

function rel(fs: FakeFs, kind: "files" | "dirs"): string[] {
  const keys = kind === "files" ? [...fs.files.keys()] : [...fs.dirs];
  return keys.map((k) => path.relative(ROOT, k).split(path.sep).join("/")).sort();
}

suite("initDocs", () => {
  test("何もない状態: config を作り、docs/design と docs/spec と README を作る", () => {
    const fs = fakeFs();
    const result = initDocs(ROOT, fs.deps);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.kept, []);
    assert.deepStrictEqual(result.created, [
      "tazuna.config.json",
      "docs/design/",
      "docs/spec/",
      "docs/README.md",
    ]);
    assert.deepStrictEqual(rel(fs, "dirs"), ["docs/design", "docs/spec"]);
    assert.deepStrictEqual(
      JSON.parse(fs.files.get(path.join(ROOT, "tazuna.config.json"))!),
      { docs: { design: "docs/design", spec: "docs/spec", handoff: "docs/HANDOFF.md" } },
    );
    assert.strictEqual(fs.files.get(path.join(ROOT, "docs", "README.md")), DOCS_README);
  });

  test("既存の config には docs だけ追記し、他のキーを保つ", () => {
    const fs = fakeFs({
      "slnmix.config.json": '﻿{\n  "extraRoots": [{ "path": "apps/web", "kind": "web" }]\n}\n',
    });
    const result = initDocs(ROOT, fs.deps);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.created[0], "slnmix.config.json (docs 設定を追記)");
    const parsed = JSON.parse(fs.files.get(path.join(ROOT, "slnmix.config.json"))!) as Record<string, unknown>;
    assert.deepStrictEqual(parsed["extraRoots"], [{ path: "apps/web", kind: "web" }]);
    assert.deepStrictEqual(parsed["docs"], { design: "docs/design", spec: "docs/spec", handoff: "docs/HANDOFF.md" });
  });

  test("2 回目は何も変えない(冪等)", () => {
    const fs = fakeFs();
    initDocs(ROOT, fs.deps);
    const before = new Map(fs.files);
    const result = initDocs(ROOT, fs.deps);
    assert.deepStrictEqual(result.created, []);
    assert.deepStrictEqual(result.kept, [
      "tazuna.config.json (docs 設定済み)",
      "docs/design/",
      "docs/spec/",
      "docs/README.md",
    ]);
    assert.deepStrictEqual([...fs.files.entries()], [...before.entries()]);
  });

  test("docs 設定が独自の配置なら、その配置でディレクトリを作る", () => {
    const fs = fakeFs({
      "slnmix.config.json": '{ "docs": { "design": "doc/design", "spec": "doc/spec", "handoff": "doc/H.md" } }',
    });
    const result = initDocs(ROOT, fs.deps);
    assert.deepStrictEqual(result.created, ["doc/design/", "doc/spec/", "doc/README.md"]);
  });

  test("壊れた config は上書きせずエラーで止まる(ディレクトリも作らない)", () => {
    const fs = fakeFs({ "slnmix.config.json": "{ broken" });
    const result = initDocs(ROOT, fs.deps);
    assert.strictEqual(result.errors.length, 1);
    assert.deepStrictEqual(result.created, []);
    assert.strictEqual(fs.files.get(path.join(ROOT, "slnmix.config.json")), "{ broken");
    assert.strictEqual(fs.dirs.size, 0);
  });
});
