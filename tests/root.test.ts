import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot } from "../src/infra/root.ts";

// パック (tazuna pack) と同じ決め方 (設計書 §25.3-2)
describe("findProjectRoot", () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-root-"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "dotnet", "Forms"), { recursive: true });
    return dir;
  };

  it("--root があればそれ", () => {
    const dir = repo();
    expect(findProjectRoot(join(dir, "dotnet"), "..")).toBe(dir);
  });

  it("設定ファイルが無ければ上に向かって最初の .git", () => {
    const dir = repo();
    expect(findProjectRoot(join(dir, "dotnet", "Forms"))).toBe(dir);
  });

  it("サブフォルダの設定ファイル (新旧どちらの名前でも) は .git より先", () => {
    const dir = repo();
    writeFileSync(join(dir, "dotnet", "slnmix.config.json"), "{}");
    expect(findProjectRoot(join(dir, "dotnet", "Forms"))).toBe(join(dir, "dotnet"));
    const other = repo();
    writeFileSync(join(other, "dotnet", "tazuna.config.json"), "{}");
    expect(findProjectRoot(join(other, "dotnet", "Forms"))).toBe(join(other, "dotnet"));
  });

  it(".git より上の設定ファイルは見ない", () => {
    const outer = mkdtempSync(join(tmpdir(), "tazuna-root-outer-"));
    writeFileSync(join(outer, "tazuna.config.json"), "{}");
    const dir = join(outer, "repo");
    mkdirSync(join(dir, ".git"), { recursive: true });
    expect(findProjectRoot(dir)).toBe(dir);
  });
});
