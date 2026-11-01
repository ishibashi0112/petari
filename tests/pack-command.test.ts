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
