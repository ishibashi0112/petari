/**
 * initProject(slnmix init)の単体テスト。ファイルシステムと petari の起動は fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import {
  GENERATED_OUTPUTS,
  initProject,
  planGitignoreAppend,
  type InitProjectDeps,
  type PetariInitOutcome,
} from "../../src/pack/initProject.ts";

const REPO = path.resolve("/work/repo");

interface FakeFs {
  deps: InitProjectDeps;
  files: Map<string, string>;
  dirs: Set<string>;
  logs: string[];
  petariCalls: string[];
}

/**
 * @param entries ルート相対のパス。末尾が / ならディレクトリ、それ以外はファイル(内容は空)
 * @param contents ルート相対パス → ファイル内容
 */
function fakeFs(
  entries: string[],
  contents: Record<string, string> = {},
  petari: PetariInitOutcome = { ok: true, output: "プロジェクトルート: x\n\nセットアップ完了。\n" },
  base: string = REPO,
): FakeFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const addDir = (dir: string): void => {
    for (let d = dir; !dirs.has(d); d = path.dirname(d)) {
      dirs.add(d);
      if (path.dirname(d) === d) break;
    }
  };
  addDir(REPO);
  addDir(base);
  for (const entry of entries) {
    const absolute = path.join(base, entry);
    if (entry.endsWith("/")) {
      addDir(path.resolve(absolute));
    } else {
      addDir(path.dirname(absolute));
      files.set(path.resolve(absolute), "");
    }
  }
  for (const [relative, content] of Object.entries(contents)) {
    const absolute = path.resolve(base, relative);
    addDir(path.dirname(absolute));
    files.set(absolute, content);
  }
  const logs: string[] = [];
  const petariCalls: string[] = [];
  const children = (dir: string, set: Iterable<string>): string[] =>
    [...set].filter((p) => path.dirname(p) === path.resolve(dir) && p !== path.resolve(dir)).map((p) => path.basename(p));
  return {
    files,
    dirs,
    logs,
    petariCalls,
    deps: {
      isDirectory: (p) => dirs.has(path.resolve(p)),
      isFile: (p) => files.has(path.resolve(p)),
      exists: (p) => dirs.has(path.resolve(p)) || files.has(path.resolve(p)),
      listFileNames: (p) => (dirs.has(path.resolve(p)) ? children(p, files.keys()) : undefined),
      listDirectoryNames: (p) => (dirs.has(path.resolve(p)) ? children(p, dirs) : undefined),
      readTextFile: (p) => files.get(path.resolve(p)),
      writeTextFile: (p, content) => {
        addDir(path.dirname(path.resolve(p)));
        files.set(path.resolve(p), content);
      },
      appendTextFile: (p, content) => {
        files.set(path.resolve(p), (files.get(path.resolve(p)) ?? "") + content);
      },
      makeDirectory: (p) => addDir(path.resolve(p)),
      runPetariInit: (rootDir) => {
        petariCalls.push(rootDir);
        return petari;
      },
      log: (line) => logs.push(line),
    },
  };
}

function readJson(fs: FakeFs, relative: string, base: string = REPO): unknown {
  const text = fs.files.get(path.resolve(base, relative));
  assert.ok(text !== undefined, `${relative} がありません`);
  return JSON.parse(text);
}

const DOCS_CONFIG = { design: "docs/design", spec: "docs/spec", handoff: "docs/HANDOFF.md" };

suite("initProject", () => {
  test("直下に .sln があれば target は書かず、docs / .gitignore / petari までまとめて行う", () => {
    const fs = fakeFs([".git/", "App.sln"]);
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "solution" });
    assert.deepStrictEqual(readJson(fs, "slnmix.config.json"), { docs: DOCS_CONFIG });
    assert.ok(fs.dirs.has(path.join(REPO, "docs", "design")));
    assert.ok(fs.dirs.has(path.join(REPO, "docs", "spec")));
    assert.ok(fs.files.has(path.join(REPO, "docs", "README.md")));
    assert.strictEqual(
      fs.files.get(path.join(REPO, ".gitignore")),
      "repomix-output.xml\nrepomix-output.prompt.md\n",
    );
    assert.deepStrictEqual(fs.petariCalls, [REPO]);
    assert.ok(fs.logs.some((line) => line.includes("App.sln(直下を自動検出")));
    // petari の出力は空行を除いて字下げして出す
    assert.ok(fs.logs.includes("   プロジェクトルート: x"));
    assert.ok(fs.logs.includes("   セットアップ完了。"));
    assert.ok(!fs.logs.includes("   "));
    assert.ok(fs.logs.some((line) => line.includes("セットアップ完了")));
    // VB.NET の構成ではビルドのコマンドも案内する
    assert.ok(fs.logs.some((line) => line.includes("npx slnmix build")));
  });

  test("2 回目は何も変えない(冪等)", () => {
    const fs = fakeFs([".git/", "App.sln"]);
    initProject(REPO, fs.deps);
    const snapshot = new Map(fs.files);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(fs.files, snapshot);
    assert.ok(fs.logs.some((line) => line.includes("生成物は除外済み")));
    // petari は毎回呼ぶ(protocol.md を最新に保つ)
    assert.strictEqual(fs.petariCalls.length, 2);
  });

  test("1 段下に .sln が 1 つだけなら target に書く(node_modules / ドット始まりは見ない)", () => {
    const fs = fakeFs([
      ".git/",
      "dotnet/App.sln",
      "web/package.json",
      "node_modules/x/Other.sln",
      "node_modules/Other.sln",
      ".vs/Cache.sln",
    ]);
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "solution" });
    assert.deepStrictEqual(readJson(fs, "slnmix.config.json"), {
      target: "dotnet/App.sln",
      docs: DOCS_CONFIG,
    });
    assert.ok(fs.logs.some((line) => line.includes("dotnet/App.sln(1 段下で見つけた .sln")));
  });

  test("1 段下に .sln が複数あれば何も書かずに止まる", () => {
    const fs = fakeFs([".git/", "a/A.sln", "b/B.sln"]);
    const before = new Map(fs.files);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(fs.files, before);
    assert.deepStrictEqual(fs.petariCalls, []);
    const error = fs.logs.find((line) => line.startsWith("[error]")) ?? "";
    assert.ok(error.includes("a/A.sln") && error.includes("b/B.sln") && error.includes('"target"'));
  });

  test("直下に .sln が複数あれば target を書くよう案内して止まる", () => {
    const fs = fakeFs([".git/", "A.sln", "B.sln"]);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(!fs.files.has(path.join(REPO, "slnmix.config.json")));
    assert.ok(fs.logs.some((line) => line.includes("複数") && line.includes("target")));
  });

  test(".sln / .vbproj が無ければ generic 構成(--init-config と同じ)を作る", () => {
    const fs = fakeFs([".git/", "src/", "tests/", "package.json"]);
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "generic" });
    // generic では MSBuild のビルドを案内しない
    assert.ok(!fs.logs.some((line) => line.includes("npx slnmix build")));
    assert.deepStrictEqual(readJson(fs, "slnmix.config.json"), {
      kind: "generic",
      extraRoots: [
        { path: "src", kind: "src" },
        { path: "tests", kind: "test" },
      ],
      docs: DOCS_CONFIG,
    });
    // 深い .sln を見落とした VB.NET プロジェクトの出口を示す
    assert.ok(fs.logs.some((line) => line.includes("2 段以上深い") && line.includes('"target"')));
  });

  test("ソースの候補も無ければ推測せずに止まる", () => {
    const fs = fakeFs([".git/", "package.json", "lib2/"]);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(!fs.files.has(path.join(REPO, "slnmix.config.json")));
    assert.ok(!fs.files.has(path.join(REPO, ".gitignore")));
    assert.deepStrictEqual(fs.petariCalls, []);
    assert.ok(fs.logs.some((line) => line.includes('"target"') && line.includes("extraRoots")));
  });

  test("リポジトリ直下でなければ何も書かずに止まる(petari のルートと揃えるため)", () => {
    const sub = path.join(REPO, "dotnet");
    const fs = fakeFs(["App.sln"], {}, { ok: true, output: "" }, sub);
    fs.dirs.add(path.join(REPO, ".git"));
    const before = new Map(fs.files);
    const result = initProject(sub, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(fs.files, before);
    assert.deepStrictEqual(fs.petariCalls, []);
    assert.ok(fs.logs.some((line) => line.includes(`リポジトリ: ${REPO}`)));
  });

  test(".git が無ければ実行した場所をそのまま使う", () => {
    const fs = fakeFs(["App.sln"]);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(fs.petariCalls, [REPO]);
  });

  test("既存の generic 設定はそのまま使い、docs 設定だけ追記する", () => {
    const config = { kind: "generic", extraRoots: [{ path: "app", kind: "src" }] };
    const fs = fakeFs([".git/", "app/"], { "slnmix.config.json": JSON.stringify(config) });
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "generic" });
    assert.deepStrictEqual(readJson(fs, "slnmix.config.json"), { ...config, docs: DOCS_CONFIG });
    assert.ok(fs.logs.some((line) => line.includes("既存の slnmix.config.json。変更なし")));
  });

  test("既存の設定の target を使う(webview2-bridge の雛形)", () => {
    const fs = fakeFs([".git/", "dotnet/App.sln"], {
      "slnmix.config.json": JSON.stringify({ target: "dotnet/App.sln" }),
    });
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "solution" });
    assert.ok(fs.logs.some((line) => line.includes("1. 構成: dotnet/App.sln(既存の")));
  });

  test("既存の設定に対象が無ければ書き方を案内して止まる", () => {
    const fs = fakeFs([".git/", "dotnet/App.sln"], { "slnmix.config.json": "{}" });
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(fs.files.get(path.join(REPO, "slnmix.config.json")), "{}");
    assert.ok(fs.logs.some((line) => line.includes('"target"') && line.includes('"kind": "generic"')));
  });

  test("壊れた slnmix.config.json は上書きせずに止まる", () => {
    const fs = fakeFs([".git/", "App.sln"], { "slnmix.config.json": "{ broken" });
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(fs.files.get(path.join(REPO, "slnmix.config.json")), "{ broken");
    assert.deepStrictEqual(fs.petariCalls, []);
  });

  test("既存の .gitignore は書き換えず末尾に追記する(CRLF・末尾改行なし・既存の規則で除外済みのもの)", () => {
    const fs = fakeFs([".git/", "App.sln"], { ".gitignore": "bin/\r\n*.xml" });
    initProject(REPO, fs.deps);
    assert.strictEqual(
      fs.files.get(path.join(REPO, ".gitignore")),
      "bin/\r\n*.xml\r\nrepomix-output.prompt.md\r\n",
    );
  });

  test("petari が失敗したら終了コード 1 と手動の手順を出す(1〜3 は済んでいる)", () => {
    const fs = fakeFs([".git/", "App.sln"], {}, { ok: false, message: "終了コード 1", output: "Error: full-ICU が必要です\n" });
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 1, layout: "solution" });
    assert.ok(fs.files.has(path.join(REPO, "slnmix.config.json")));
    assert.ok(fs.files.has(path.join(REPO, ".gitignore")));
    assert.ok(fs.logs.some((line) => line.includes("npx petari init --yes --no-repomix")));
    assert.ok(fs.logs.includes("   Error: full-ICU が必要です"));
  });
});

suite("planGitignoreAppend", () => {
  test(".gitignore が無ければ生成物をすべて書く", () => {
    assert.deepStrictEqual(planGitignoreAppend(undefined, GENERATED_OUTPUTS), {
      append: "repomix-output.xml\nrepomix-output.prompt.md\n",
      added: ["repomix-output.xml", "repomix-output.prompt.md"],
    });
  });

  test("既存の規則(ワイルドカード・先頭 /)で除外済みなら何もしない", () => {
    assert.strictEqual(planGitignoreAppend("repomix-output.*\n", GENERATED_OUTPUTS), undefined);
    assert.strictEqual(
      planGitignoreAppend("/repomix-output.xml\n/repomix-output.prompt.md\n", GENERATED_OUTPUTS),
      undefined,
    );
  });

  test("末尾に改行が無ければ改行を足してから追記する", () => {
    const plan = planGitignoreAppend("node_modules/", GENERATED_OUTPUTS);
    assert.ok(plan !== undefined && plan.append === "\nrepomix-output.xml\nrepomix-output.prompt.md\n");
  });
});
