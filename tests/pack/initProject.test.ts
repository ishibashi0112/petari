/**
 * initProject(petari init。旧 slnmix init + petari init)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { PROTOCOL_TEXT, PROTOCOL_VERSION } from "../../src/assets/protocol.ts";
import { CONFIG_TEMPLATE } from "../../src/infra/config.ts";
import {
  GENERATED_OUTPUTS,
  initProject,
  planGitignoreAppend,
  type InitProjectDeps,
} from "../../src/pack/initProject.ts";

const REPO = path.resolve("/work/repo");

interface FakeFs {
  deps: InitProjectDeps;
  files: Map<string, string>;
  dirs: Set<string>;
  logs: string[];
}

/**
 * @param entries ルート相対のパス。末尾が / ならディレクトリ、それ以外はファイル(内容は空)
 * @param contents ルート相対パス → ファイル内容
 */
function fakeFs(
  entries: string[],
  contents: Record<string, string> = {},
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
  const children = (dir: string, set: Iterable<string>): string[] =>
    [...set].filter((p) => path.dirname(p) === path.resolve(dir) && p !== path.resolve(dir)).map((p) => path.basename(p));
  return {
    files,
    dirs,
    logs,
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
  test("直下に .sln があれば target は書かず、docs / .gitignore / .petari/ までまとめて行う", () => {
    const fs = fakeFs([".git/", "App.sln"]);
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "solution" });
    assert.deepStrictEqual(readJson(fs, "petari.config.json"), { docs: DOCS_CONFIG });
    assert.ok(fs.dirs.has(path.join(REPO, "docs", "design")));
    assert.ok(fs.dirs.has(path.join(REPO, "docs", "spec")));
    assert.ok(fs.files.has(path.join(REPO, "docs", "README.md")));
    assert.strictEqual(
      fs.files.get(path.join(REPO, ".gitignore")),
      "repomix-output.xml\nrepomix-output.prompt.md\n.petari/\n",
    );
    assert.strictEqual(fs.files.get(path.join(REPO, ".petari", "config.json")), CONFIG_TEMPLATE);
    // 規約文は内蔵。protocol.md も repomix.config.json も作らない
    assert.ok(!fs.files.has(path.join(REPO, "protocol.md")));
    assert.ok(!fs.files.has(path.join(REPO, "repomix.config.json")));
    assert.ok(fs.logs.includes(`5. 規約文: 内蔵 v${PROTOCOL_VERSION}`));
    assert.ok(fs.logs.some((line) => line.includes("App.sln(直下を自動検出")));
    assert.ok(fs.logs.some((line) => line.includes("セットアップ完了")));
    assert.ok(fs.logs.some((line) => line.includes("npx petari pack")));
    // VB.NET の構成ではビルドのコマンドも案内する
    assert.ok(fs.logs.some((line) => line.includes("npx petari build")));
    assert.ok(fs.logs.some((line) => line.startsWith("petari.config.json・docs/ は git にコミット")));
  });

  test("旧 init が書いた手を加えていない protocol.md は、削除してよいと案内する(消さない)", () => {
    const fs = fakeFs([".git/", "App.sln"], { "protocol.md": PROTOCOL_TEXT.replace(/\n/g, "\r\n") });
    assert.strictEqual(initProject(REPO, fs.deps).exitCode, 0);
    assert.ok(fs.files.has(path.join(REPO, "protocol.md")));
    assert.ok(fs.logs.some((line) => line.startsWith("5. 規約文: 内蔵") && line.includes("削除してかまいません")));
  });

  test("古い版に手を加えた protocol.md は上書きとして使い、警告する", () => {
    const fs = fakeFs([".git/", "App.sln"], { "protocol.md": "<!-- petari protocol v2 -->\n社内の規約\n" });
    assert.strictEqual(initProject(REPO, fs.deps).exitCode, 0);
    assert.ok(fs.logs.some((line) => line.startsWith("5. 規約文:") && line.includes("上書き")));
    assert.ok(fs.logs.some((line) => line.includes("[warning]") && line.includes("v2")));
  });

  test("既存の .petari/config.json・.gitignore の .petari 行は変えない", () => {
    const fs = fakeFs([".git/", "App.sln"], {
      ".petari/config.json": '{ "downloadsDir": "D:/dl" }\n',
      ".gitignore": ".petari\n",
    });
    assert.strictEqual(initProject(REPO, fs.deps).exitCode, 0);
    assert.strictEqual(fs.files.get(path.join(REPO, ".petari", "config.json")), '{ "downloadsDir": "D:/dl" }\n');
    assert.strictEqual(
      fs.files.get(path.join(REPO, ".gitignore")),
      ".petari\nrepomix-output.xml\nrepomix-output.prompt.md\n",
    );
  });

  test("2 回目は何も変えない(冪等)", () => {
    const fs = fakeFs([".git/", "App.sln"]);
    initProject(REPO, fs.deps);
    const snapshot = new Map(fs.files);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(fs.files, snapshot);
    assert.ok(fs.logs.some((line) => line.includes("生成物と .petari/ は除外済み")));
    assert.ok(fs.logs.some((line) => line.includes(".petari/config.json: 既存")));
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
    assert.deepStrictEqual(readJson(fs, "petari.config.json"), {
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
    const error = fs.logs.find((line) => line.startsWith("[error]")) ?? "";
    assert.ok(error.includes("a/A.sln") && error.includes("b/B.sln") && error.includes('"target"'));
  });

  test("直下に .sln が複数あれば target を書くよう案内して止まる", () => {
    const fs = fakeFs([".git/", "A.sln", "B.sln"]);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(!fs.files.has(path.join(REPO, "petari.config.json")));
    assert.ok(fs.logs.some((line) => line.includes("複数") && line.includes("target")));
  });

  test(".sln / .vbproj が無い git のリポジトリでは、git が管理しているファイルを対象にする generic 構成を作る", () => {
    const fs = fakeFs([".git/", "lib2/", "package.json"]);
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "generic" });
    assert.ok(!fs.logs.some((line) => line.includes("npx petari build")));
    assert.deepStrictEqual(readJson(fs, "petari.config.json"), { kind: "generic", docs: DOCS_CONFIG });
    assert.ok(fs.logs.some((line) => line.includes("git が管理しているファイルを対象にする")));
    assert.ok(fs.logs.some((line) => line.includes(".repomixignore")));
    assert.ok(fs.logs.some((line) => line.includes("2 段以上深い") && line.includes('"target"')));
  });

  test(".sln / .vbproj も git も無ければ、候補のディレクトリで generic 構成(--init-config と同じ)を作る", () => {
    const fs = fakeFs(["src/", "tests/", "package.json"]);
    const result = initProject(REPO, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "generic" });
    // generic では MSBuild のビルドを案内しない
    assert.ok(!fs.logs.some((line) => line.includes("npx petari build")));
    assert.deepStrictEqual(readJson(fs, "petari.config.json"), {
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

  test("git の外でソースの候補も無ければ推測せずに止まる", () => {
    const fs = fakeFs(["package.json", "lib2/"]);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.ok(!fs.files.has(path.join(REPO, "petari.config.json")));
    assert.ok(!fs.files.has(path.join(REPO, ".gitignore")));
    assert.ok(fs.logs.some((line) => line.includes('"target"') && line.includes("extraRoots")));
  });

  test("リポジトリの途中(設定ファイルなし)を指したら何も書かずに止まる(パックと適用のルートを揃えるため)", () => {
    const sub = path.join(REPO, "dotnet");
    const fs = fakeFs(["App.sln"], {}, sub);
    fs.dirs.add(path.join(REPO, ".git"));
    const before = new Map(fs.files);
    const result = initProject(sub, fs.deps);
    assert.strictEqual(result.exitCode, 1);
    assert.deepStrictEqual(fs.files, before);
    assert.ok(fs.logs.some((line) => line.includes(`リポジトリ: ${REPO}`)));
  });

  test("設定ファイルのあるサブフォルダはルートとして使える(パックと適用もそこをルートにする)", () => {
    const sub = path.join(REPO, "dotnet");
    const fs = fakeFs(["App.sln"], { "slnmix.config.json": "{}" }, sub);
    fs.dirs.add(path.join(REPO, ".git"));
    const result = initProject(sub, fs.deps);
    assert.deepStrictEqual(result, { exitCode: 0, layout: "solution" });
    assert.ok(fs.files.has(path.join(sub, ".petari", "config.json")));
  });

  test(".git が無ければ実行した場所をそのまま使う", () => {
    const fs = fakeFs(["App.sln"]);
    const result = initProject(REPO, fs.deps);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(fs.files.has(path.join(REPO, ".petari", "config.json")));
  });

  test("旧名の slnmix.config.json はそのままの名前で使い、新しい名前の設定を作らない", () => {
    const fs = fakeFs([".git/", "App.sln"], { "slnmix.config.json": "{}" });
    assert.strictEqual(initProject(REPO, fs.deps).exitCode, 0);
    assert.deepStrictEqual(readJson(fs, "slnmix.config.json"), { docs: DOCS_CONFIG });
    assert.ok(!fs.files.has(path.join(REPO, "petari.config.json")));
    assert.ok(fs.logs.some((line) => line.startsWith("slnmix.config.json・docs/ は git にコミット")));
  });

  test("設定ファイルが新旧の名前で両方あれば何も書かずに止まる", () => {
    const fs = fakeFs([".git/", "App.sln"], { "slnmix.config.json": "{}", "petari.config.json": "{}" });
    const before = new Map(fs.files);
    assert.strictEqual(initProject(REPO, fs.deps).exitCode, 1);
    assert.deepStrictEqual(fs.files, before);
    assert.ok(fs.logs.some((line) => line.includes("両方あります")));
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
  });

  test("既存の .gitignore は書き換えず末尾に追記する(CRLF・末尾改行なし・既存の規則で除外済みのもの)", () => {
    const fs = fakeFs([".git/", "App.sln"], { ".gitignore": "bin/\r\n*.xml" });
    initProject(REPO, fs.deps);
    assert.strictEqual(
      fs.files.get(path.join(REPO, ".gitignore")),
      "bin/\r\n*.xml\r\nrepomix-output.prompt.md\r\n.petari/\r\n",
    );
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

  test("末尾 / の項目は、その中のファイルが除外されているかで判定する", () => {
    assert.strictEqual(planGitignoreAppend(".petari\n", [".petari/"]), undefined);
    assert.strictEqual(planGitignoreAppend("/.petari/\n", [".petari/"]), undefined);
    assert.deepStrictEqual(planGitignoreAppend(".petari.bak\n", [".petari/"]), { append: ".petari/\n", added: [".petari/"] });
  });

  test("末尾に改行が無ければ改行を足してから追記する", () => {
    const plan = planGitignoreAppend("node_modules/", GENERATED_OUTPUTS);
    assert.ok(plan !== undefined && plan.append === "\nrepomix-output.xml\nrepomix-output.prompt.md\n");
  });
});
