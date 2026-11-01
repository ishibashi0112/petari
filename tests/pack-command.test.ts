import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_TEXT } from "../src/assets/protocol.ts";
import { packCommand } from "../src/commands/pack.ts";

const BASIC = resolve(import.meta.dirname, "fixtures", "pack", "basic");

/** packCommand を実行して stdout / stderr を捕まえる */
function run(argv: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const before = process.cwd();
  try {
    process.chdir(cwd);
    return { code: packCommand(argv), stdout, stderr };
  } finally {
    process.chdir(before);
    vi.restoreAllMocks();
  }
}

/** .git のあるリポジトリの dotnet/ に basic フィクスチャを置く */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "petari-pack-"));
  mkdirSync(join(dir, ".git"));
  cpSync(BASIC, join(dir, "dotnet"), { recursive: true });
  return dir;
}

describe("petari pack (設計書 §25)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("設定ファイルが無ければ .git の場所がルート (<file path> が適用のルートと揃う)", () => {
    const dir = repo();
    const result = run(["Basic.vbproj", "--stdout", "--no-clip"], join(dir, "dotnet"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('<file path="dotnet/Module1.vb"');
    expect(result.stderr).toContain(`ルート: ${dir}(リポジトリの直下(.git の場所))`);
  });

  it("規約文は内蔵 (protocol.md が無くても <instruction> が入る)。--no-instruction で外せる", () => {
    const dir = repo();
    const result = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip"], dir);
    expect(result.stdout).toContain(`<instruction>\n${PROTOCOL_TEXT}`);
    expect(result.stderr).toMatch(/規約文: 内蔵 v\d+\n/);
    const without = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip", "--no-instruction"], dir);
    expect(without.stdout).not.toContain("\n<instruction>\n");
  });

  it("手を加えた protocol.md は上書きとして使う", () => {
    const dir = repo();
    writeFileSync(join(dir, "protocol.md"), "# 社内の規約\n");
    const result = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip"], dir);
    expect(result.stdout).toContain("<instruction>\n# 社内の規約\n</instruction>");
  });

  it("設定ファイルが新旧の名前で両方あれば止める", () => {
    const dir = repo();
    writeFileSync(join(dir, "petari.config.json"), "{}");
    writeFileSync(join(dir, "slnmix.config.json"), "{}");
    const result = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip"], dir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("両方あります");
  });

  it("旧名の slnmix.config.json の target を使う", () => {
    const dir = repo();
    writeFileSync(join(dir, "slnmix.config.json"), JSON.stringify({ target: "dotnet/Basic.vbproj" }));
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('<file path="dotnet/Module1.vb"');
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("petari pack: generic 構成で extraRoots が無ければ git が管理しているファイル (設計書 §25.7)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** git init したリポジトリに Python / TS のファイルを置く */
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "petari-pack-git-"));
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir });
      if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    git("init", "-q", ".");
    writeFileSync(join(dir, "petari.config.json"), '{ "kind": "generic" }\n');
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "main.py"), 'import os\npassword = "hunter2xyz"\n');
    writeFileSync(join(dir, "app", "web.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "poetry.lock"), "# lock\n");
    writeFileSync(join(dir, "app", "data.bin"), Buffer.from([0x50, 0x00, 0x01, 0x02]));
    mkdirSync(join(dir, "node_modules", "m"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "m", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(dir, "debug.log"), "secret log\n");
    git("add", "petari.config.json", ".gitignore", "app/main.py", "poetry.lock", "app/data.bin");
    // app/web.ts は未追跡(.gitignore に一致しないので対象)
    return dir;
  }

  it.skipIf(!hasGit)("追跡中と未追跡(.gitignore 以外)のファイルを入れ、ロックファイル・バイナリ・ignore を除く", () => {
    const dir = gitRepo();
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("git が管理しているファイル(git ls-files)に基づき");
    expect(result.stdout).toContain('<file path="app/main.py">');
    expect(result.stdout).toContain('<file path="app/web.ts">');
    expect(result.stdout).toContain('<file path=".gitignore">');
    expect(result.stdout).not.toContain('<file path="poetry.lock"');
    expect(result.stdout).not.toContain('<file path="app/data.bin"');
    expect(result.stdout).not.toContain("node_modules/m");
    expect(result.stdout).not.toContain("debug.log");
    expect(result.stdout).not.toContain("hunter2xyz");
    expect(result.stdout).toMatch(/<directory_structure>\n\.\/\n {2}app\/\n/);
    expect(result.stderr).toContain("設定: petari.config.json(git が管理しているファイル)");
  });

  it.skipIf(!hasGit)("<docs> / <db_schema> に入るファイルは <file> に重ねない", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "petari.config.json"), '{ "kind": "generic", "docs": true }\n');
    mkdirSync(join(dir, "docs", "design"), { recursive: true });
    mkdirSync(join(dir, "docs", "db"), { recursive: true });
    writeFileSync(join(dir, "docs", "design", "x.md"), "<!-- slnmix design: status=ready blocking=0 deferred=0 -->\n# x\n");
    writeFileSync(join(dir, "docs", "db", "schema.md"), "# schema\n");
    writeFileSync(join(dir, "docs", "notes.md"), "# notes\n");
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('<file path="docs/design/x.md"');
    expect(result.stdout).not.toContain('<file path="docs/db/schema.md"');
    expect(result.stdout).toContain('<doc path="docs/design/x.md"');
    expect(result.stdout).toContain("- docs/design/x.md: <docs> に入れたため <file> には入れない");
    expect(result.stdout).toContain('<file path="docs/notes.md">');
  });

  it("git のリポジトリでなければ、extraRoots を書くよう案内して止める", () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-pack-nogit-"));
    writeFileSync(join(dir, "petari.config.json"), '{ "kind": "generic" }\n');
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git が管理しているファイルを一覧できません");
    expect(result.stderr).toContain("extraRoots");
  });
});
