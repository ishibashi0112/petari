/**
 * gitignoreMatcher(.gitignore のパターン照合の自前実装)のテスト。
 * 決まった書き方の確認に加えて、同じパターンとパスを `git check-ignore` にもかけて結果が一致することを確かめる
 * (git が無い環境ではその部分を飛ばす)。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert, describe, it } from "vitest";
import { GitignoreRules } from "../../src/pack/services/gitignoreMatcher.ts";

describe("gitignoreMatcher: 書き方", () => {
  const ignored = (rules: string, p: string): boolean => new GitignoreRules(rules).ignores(p);

  it("名前だけのパターンはどの階層にも一致する", () => {
    assert.isTrue(ignored("*.log", "a.log"));
    assert.isTrue(ignored("*.log", "x/y/a.log"));
    assert.isFalse(ignored("*.log", "a.logx"));
  });

  it("先頭・途中の / は .gitignore の場所からの相対", () => {
    assert.isTrue(ignored("/dist", "dist/a.js"));
    assert.isFalse(ignored("/dist", "src/dist/a.js"));
    assert.isTrue(ignored("doc/*.txt", "doc/a.txt"));
    assert.isFalse(ignored("doc/*.txt", "x/doc/a.txt"));
    assert.isFalse(ignored("doc/*.txt", "doc/x/a.txt"));
  });

  it("末尾の / はディレクトリだけ(中のファイルは無視される)", () => {
    assert.isTrue(ignored("bin/", "bin/Debug/a.dll"));
    assert.isFalse(ignored("bin/", "bin"));
  });

  it("** は 0 個以上のディレクトリ", () => {
    assert.isTrue(ignored("**/obj", "a/b/obj/x"));
    assert.isTrue(ignored("a/**/b", "a/b"));
    assert.isTrue(ignored("a/**/b", "a/x/y/b"));
    assert.isTrue(ignored("a/**", "a/x/y"));
    assert.isFalse(ignored("a/**", "a"));
  });

  it("否定で戻す。親ディレクトリが無視されていれば戻らない", () => {
    assert.isFalse(ignored("*.log\n!keep.log", "keep.log"));
    assert.isTrue(ignored("logs/\n!logs/keep.log", "logs/keep.log"));
    const verdict = new GitignoreRules("*.log\n!keep.log").test("keep.log");
    assert.deepStrictEqual(verdict, { ignored: false, unignored: true });
  });

  it("コメント・空行・末尾の空白・エスケープ", () => {
    assert.isFalse(ignored("# a.txt\n\n", "a.txt"));
    assert.isTrue(ignored("a.txt   ", "a.txt"));
    assert.isTrue(ignored("\\#a", "#a"));
    assert.isTrue(ignored("\\!a", "!a"));
    assert.isTrue(ignored("a\\ ", "a "));
  });

  it("文字クラスと ?", () => {
    assert.isTrue(ignored("[Bb]in/", "Bin/x"));
    assert.isTrue(ignored("x?z", "xyz"));
    assert.isFalse(ignored("x?z", "x/z"));
    assert.isTrue(ignored("[!a]b", "cb"));
    assert.isFalse(ignored("[!a]b", "ab"));
    assert.isTrue(ignored("[[:digit:]]x", "1x"));
  });

  it("大文字と小文字は区別しない(既定)", () => {
    assert.isTrue(ignored("*.LOG", "a.log"));
    assert.isFalse(new GitignoreRules("*.LOG", false).ignores("a.log"));
  });
});

/** 決まった種から作る疑似乱数(テストの再現性のため) */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("gitignoreMatcher: git check-ignore と同じ結果", () => {
  it.skipIf(!hasGit)("組み合わせたパターンとパスで一致する", () => {
    const rnd = random(20261101);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
    const parts = ["a", "b", "ab", "*", "**", "?", "[ab]", "[!a]", "[a-c]", ".", "A", "x.y", "\\*", "[[:alpha:]]", "bin", "*.log"];
    const names = ["a", "b", "ab", "A", "x.y", "c", ".a", "ba", "abc", "bin", "x.log", "Bin"];
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tazuna-gitignore-"));
    try {
      spawnSync("git", ["init", "-q", repo]);
      let compared = 0;
      for (let round = 0; round < 60; round++) {
        const patterns = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
          let p = "";
          const n = 1 + Math.floor(rnd() * 3);
          for (let i = 0; i < n; i++) {
            if (i > 0 || rnd() < 0.2) p += "/";
            p += pick(parts) + (rnd() < 0.3 ? pick(parts) : "");
          }
          if (rnd() < 0.2) p += "/";
          if (rnd() < 0.25) p = "!" + p;
          return p;
        });
        const text = patterns.join("\n") + "\n";
        fs.writeFileSync(path.join(repo, ".gitignore"), text);
        const paths = [
          ...new Set(
            Array.from({ length: 25 }, () =>
              Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(names)).join("/"),
            ),
          ),
        ];
        const run = spawnSync(
          "git",
          ["-c", "core.ignorecase=true", "check-ignore", "--no-index", "-v", "-n", "--stdin"],
          { cwd: repo, input: paths.join("\n") + "\n" },
        );
        const git = new Map<string, boolean>();
        for (const line of run.stdout.toString().split("\n").filter(Boolean)) {
          const [info = "", p = ""] = line.split("\t");
          const pattern = info.split(":").slice(2).join(":");
          git.set(p, info !== "::" && !pattern.startsWith("!"));
        }
        const rules = new GitignoreRules(text);
        for (const p of paths) {
          assert.strictEqual(rules.ignores(p), git.get(p), `${JSON.stringify(patterns)} ${p}`);
          compared += 1;
        }
      }
      assert.isAbove(compared, 1000);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
