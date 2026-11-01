/**
 * gitignoreService の単体テスト。
 * ファイルシステムは fake を注入し、git の仕様(否定・ネスト・境界)を検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import { type GitignoreDeps, GitignoreEvaluator } from "../../src/pack/services/gitignoreService.ts";

/** in-memory の fake ファイルシステム */
function makeDeps(
  files: Record<string, string>,
  directories: string[] = [],
): GitignoreDeps {
  return {
    readTextFileIfExists: (p) => files[p],
    directoryExists: (p) => directories.includes(p),
  };
}

suite("gitignoreService: 基本パターン", () => {
  test(".gitignore に一致するファイルを除外対象と判定する", () => {
    const deps = makeDeps({ "/base/.gitignore": "*.log\nbin/\n" });
    const evaluator = new GitignoreEvaluator(deps, "/base");
    assert.strictEqual(
      evaluator.ignoreReasonFor("/base/logs/app.log"),
      "/base/.gitignore",
    );
    assert.strictEqual(
      evaluator.ignoreReasonFor("/base/bin/Debug/App.exe"),
      "/base/.gitignore",
    );
    assert.strictEqual(evaluator.ignoreReasonFor("/base/src/Main.vb"), undefined);
  });

  test("! による除外解除(否定パターン)に対応する", () => {
    const deps = makeDeps({
      "/base/.gitignore": "secret/*\n!secret/keep.vb\n",
    });
    const evaluator = new GitignoreEvaluator(deps, "/base");
    assert.notStrictEqual(evaluator.ignoreReasonFor("/base/secret/db.txt"), undefined);
    assert.strictEqual(evaluator.ignoreReasonFor("/base/secret/keep.vb"), undefined);
  });

  test("大文字小文字を区別しない(Windows 前提)", () => {
    const deps = makeDeps({ "/base/.gitignore": "*.LOG\n" });
    const evaluator = new GitignoreEvaluator(deps, "/base");
    assert.notStrictEqual(evaluator.ignoreReasonFor("/base/app.log"), undefined);
  });

  test(".repomixignore も同様に扱う", () => {
    const deps = makeDeps({ "/base/.repomixignore": "*.tmp\n" });
    const evaluator = new GitignoreEvaluator(deps, "/base");
    assert.strictEqual(
      evaluator.ignoreReasonFor("/base/work.tmp"),
      "/base/.repomixignore",
    );
  });
});

suite("gitignoreService: ネストと優先順位", () => {
  test("近い .gitignore の判定が優先される(除外解除)", () => {
    const deps = makeDeps({
      "/base/.gitignore": "*.tmp\n",
      "/base/sub/.gitignore": "!important.tmp\n",
    });
    const evaluator = new GitignoreEvaluator(deps, "/base");
    // sub 配下では除外解除が効く
    assert.strictEqual(
      evaluator.ignoreReasonFor("/base/sub/important.tmp"),
      undefined,
    );
    // sub 以外では親の除外が効く
    assert.notStrictEqual(evaluator.ignoreReasonFor("/base/other.tmp"), undefined);
  });
});

suite("gitignoreService: 探索境界", () => {
  test(".git のあるリポジトリルートで探索を打ち切る", () => {
    const deps = makeDeps(
      {
        // リポジトリルートより上にある .gitignore(適用してはいけない)
        "/.gitignore": "*.vb\n",
        "/repo/.gitignore": "*.log\n",
      },
      ["/repo/.git"],
    );
    const evaluator = new GitignoreEvaluator(deps, "/repo/app");
    // リポジトリ内の .gitignore は効く
    assert.notStrictEqual(evaluator.ignoreReasonFor("/repo/app/x.log"), undefined);
    // ルートより上の *.vb は適用されない
    assert.strictEqual(evaluator.ignoreReasonFor("/repo/app/Main.vb"), undefined);
  });

  test(".git が無い場合は基準ディレクトリ配下のみ適用する", () => {
    const deps = makeDeps({
      // 基準ディレクトリの外(適用してはいけない)
      "/outer/.gitignore": "*.vb\n",
      "/outer/base/.gitignore": "*.log\n",
    });
    const evaluator = new GitignoreEvaluator(deps, "/outer/base");
    assert.notStrictEqual(
      evaluator.ignoreReasonFor("/outer/base/x.log"),
      undefined,
    );
    assert.strictEqual(
      evaluator.ignoreReasonFor("/outer/base/Main.vb"),
      undefined,
    );
  });

  test("ignore ファイルが無ければ何も除外しない", () => {
    const evaluator = new GitignoreEvaluator(makeDeps({}), "/base");
    assert.strictEqual(evaluator.ignoreReasonFor("/base/anything.vb"), undefined);
  });
});
