import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { sjisEncode } from "../src/core/sjis.ts";
import type { Manifest } from "../src/infra/history.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sjis = (s: string): Uint8Array => sjisEncode(s).bytes;
const doc = (...lines: string[]): string => lines.join("\n");

function setupProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "petari-test-"));
  writeFileSync(join(dir, "legacy.vb"), sjis("' コメント\r\nDim count As Integer = 1\r\nEnd Module"));
  writeFileSync(join(dir, "old.txt"), utf8("obsolete\n"));
  return dir;
}

const CHANGES = doc(
  "## CHANGES",
  "",
  "カウンタ初期値の変更、新規ファイル追加、不要ファイル削除。",
  "",
  "### FILE: legacy.vb (replace)",
  "<<<<<<< SEARCH",
  "Dim count As Integer = 1",
  "=======",
  "Dim count As Integer = 100",
  ">>>>>>> REPLACE",
  "",
  "### FILE: sub/new.ts (create)",
  "<<<<<<< CONTENT",
  "export const x = 1;",
  ">>>>>>> END",
  "",
  "### FILE: old.txt (delete)",
);

function historyIds(dir: string): string[] {
  const h = join(dir, ".petari", "history");
  return existsSync(h) ? readdirSync(h) : [];
}

describe("applyCommand (統合・§4.1)", () => {
  it("全件成功: 適用・履歴保存・エンコーディング保全", async () => {
    const dir = setupProject();
    const changesPath = join(dir, "changes.md");
    writeFileSync(changesPath, CHANGES, "utf8");

    const code = await applyCommand([changesPath, "--root", dir, "--yes"]);
    expect(code).toBe(0);

    // Shift_JIS + CRLF + 末尾改行なしが維持され、変更行のみ変わる
    expect(new Uint8Array(readFileSync(join(dir, "legacy.vb")))).toEqual(
      sjis("' コメント\r\nDim count As Integer = 100\r\nEnd Module"),
    );
    // create は UTF-8/LF + 末尾改行
    expect(new Uint8Array(readFileSync(join(dir, "sub", "new.ts")))).toEqual(
      utf8("export const x = 1;\n"),
    );
    // delete
    expect(existsSync(join(dir, "old.txt"))).toBe(false);

    // 履歴 (§5)
    const ids = historyIds(dir);
    expect(ids).toHaveLength(1);
    const hdir = join(dir, ".petari", "history", ids[0] as string);
    expect(readFileSync(join(hdir, "changes.md"), "utf8")).toBe(CHANGES);
    expect(existsSync(join(hdir, "before", "legacy.vb"))).toBe(true);
    expect(existsSync(join(hdir, "before", "old.txt"))).toBe(true);
    expect(existsSync(join(hdir, "after", "legacy.vb"))).toBe(true);
    expect(existsSync(join(hdir, "after", "sub", "new.ts"))).toBe(true);
    // create に before はなく、delete に after はない
    expect(existsSync(join(hdir, "before", "sub", "new.ts"))).toBe(false);
    expect(existsSync(join(hdir, "after", "old.txt"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(hdir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.success).toBe(true);
    expect(manifest.partial).toBe(false);
    expect(manifest.files).toHaveLength(3);
    const legacy = manifest.files.find((f) => f.path === "legacy.vb");
    expect(legacy?.beforeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(legacy?.afterSha256).toMatch(/^[0-9a-f]{64}$/);
    const deleted = manifest.files.find((f) => f.path === "old.txt");
    expect(deleted?.afterSha256).toBeNull();
  });

  it("1 件でも失敗があれば何も書き込まない (all-or-nothing・§4.1)", async () => {
    const dir = setupProject();
    const changesPath = join(dir, "changes.md");
    const bad = CHANGES.replace("Dim count As Integer = 1\n", "存在しない行\n");
    writeFileSync(changesPath, bad, "utf8");

    const code = await applyCommand([changesPath, "--root", dir, "--yes"]);
    expect(code).toBe(1);
    // 他ファイルの変更 (create/delete) も一切適用されない
    expect(existsSync(join(dir, "sub", "new.ts"))).toBe(false);
    expect(existsSync(join(dir, "old.txt"))).toBe(true);
    expect(historyIds(dir)).toHaveLength(0);
  });

  it("--dry-run は何も書き込まない", async () => {
    const dir = setupProject();
    const changesPath = join(dir, "changes.md");
    writeFileSync(changesPath, CHANGES, "utf8");

    const code = await applyCommand([changesPath, "--root", dir, "--yes", "--dry-run"]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "sub", "new.ts"))).toBe(false);
    expect(existsSync(join(dir, "old.txt"))).toBe(true);
    expect(historyIds(dir)).toHaveLength(0);
  });

  it("--partial は成功分のみ適用し、スキップ情報を manifest に残す", async () => {
    const dir = setupProject();
    const changesPath = join(dir, "changes.md");
    const bad = CHANGES.replace("Dim count As Integer = 1\n", "存在しない行\n");
    writeFileSync(changesPath, bad, "utf8");

    const code = await applyCommand([changesPath, "--root", dir, "--yes", "--partial"]);
    expect(code).toBe(0);
    // 失敗した replace は未適用、成功した create/delete は適用
    expect(existsSync(join(dir, "sub", "new.ts"))).toBe(true);
    expect(existsSync(join(dir, "old.txt"))).toBe(false);

    const ids = historyIds(dir);
    const manifest = JSON.parse(
      readFileSync(join(dir, ".petari", "history", ids[0] as string, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.partial).toBe(true);
    expect(manifest.success).toBe(false);
    const legacy = manifest.files.find((f) => f.path === "legacy.vb");
    expect(legacy?.appliedBlocks).toBe(0);
    expect(legacy?.skippedBlocks?.[0]?.reason).toContain("見つかりません");
  });

  it("構文エラーは即時失敗しレポートを出す", async () => {
    const dir = setupProject();
    const changesPath = join(dir, "changes.md");
    writeFileSync(changesPath, "## CHANGES\n概要\n### FILE: a.ts\n", "utf8");
    const code = await applyCommand([changesPath, "--root", dir, "--yes"]);
    expect(code).toBe(1);
    expect(historyIds(dir)).toHaveLength(0);
  });
});
