import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { listCommand } from "../src/commands/list.ts";
import { undoCommand } from "../src/commands/undo.ts";
import { resolveDiffPair } from "../src/commands/show.ts";
import { sjisEncode } from "../src/core/sjis.ts";
import { listHistoryIds } from "../src/infra/history.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sjis = (s: string): Uint8Array => sjisEncode(s).bytes;
const doc = (...lines: string[]): string => lines.join("\n");

const CHANGES = doc(
  "## CHANGES",
  "",
  "テスト変更一式。",
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

const ORIGINAL_VB = sjis("' コメント\r\nDim count As Integer = 1\r\nEnd Module");

async function setupApplied(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "petari-undo-"));
  writeFileSync(join(dir, "legacy.vb"), ORIGINAL_VB);
  writeFileSync(join(dir, "old.txt"), utf8("obsolete\n"));
  writeFileSync(join(dir, "changes.md"), CHANGES, "utf8");
  const code = await applyCommand([join(dir, "changes.md"), "--root", dir, "--yes"]);
  expect(code).toBe(0);
  return dir;
}

describe("undoCommand (§4.2)", () => {
  it("直近履歴を正しく逆適用する (replace 復元 / create 削除 / delete 復元)", async () => {
    const dir = await setupApplied();
    const code = await undoCommand(["--root", dir, "--yes"]);
    expect(code).toBe(0);

    // replace → before のバイト列そのものに戻る (Shift_JIS + CRLF + 末尾改行なし)
    expect(new Uint8Array(readFileSync(join(dir, "legacy.vb")))).toEqual(ORIGINAL_VB);
    // create → 削除される
    expect(existsSync(join(dir, "sub", "new.ts"))).toBe(false);
    // delete → before から復元される
    expect(new Uint8Array(readFileSync(join(dir, "old.txt")))).toEqual(utf8("obsolete\n"));
  });

  it("ID 指定で巻き戻せる", async () => {
    const dir = await setupApplied();
    const id = listHistoryIds(dir)[0] as string;
    expect(await undoCommand([id, "--root", dir, "--yes"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "legacy.vb")))).toEqual(ORIGINAL_VB);
  });

  it("存在しない ID はエラー", async () => {
    const dir = await setupApplied();
    expect(await undoCommand(["9999-01-01_0000", "--root", dir, "--yes"])).toBe(1);
  });

  it("履歴がなければエラー", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-undo-empty-"));
    expect(await undoCommand(["--root", dir, "--yes"])).toBe(1);
  });

  it("手修正があっても --yes なら巻き戻す (undo 後は before の内容)", async () => {
    const dir = await setupApplied();
    writeFileSync(join(dir, "legacy.vb"), sjis("手修正した内容\r\n"));
    expect(await undoCommand(["--root", dir, "--yes"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "legacy.vb")))).toEqual(ORIGINAL_VB);
  });
});

describe("listCommand (§4.4)", () => {
  it("履歴一覧を表示して 0 で終了する", async () => {
    const dir = await setupApplied();
    expect(await listCommand(["--root", dir])).toBe(0);
  });

  it("履歴がなくても 0 で終了する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-list-empty-"));
    expect(await listCommand(["--root", dir])).toBe(0);
  });
});

describe("resolveDiffPair (§4.3)", () => {
  it("通常は before/after、create は空 vs after、--mine は after vs 現在", async () => {
    const dir = await setupApplied();
    const id = listHistoryIds(dir)[0] as string;
    const hdir = join(dir, ".petari", "history", id);

    const rep = resolveDiffPair(
      dir,
      hdir,
      { path: "legacy.vb", op: "replace", applied: true, blocks: 1, appliedBlocks: 1, beforeSha256: "x", afterSha256: "y" },
      false,
    );
    expect(rep).toMatchObject({
      left: join(hdir, "before", "legacy.vb"),
      right: join(hdir, "after", "legacy.vb"),
    });

    const created = resolveDiffPair(
      dir,
      hdir,
      { path: "sub/new.ts", op: "create", applied: true, blocks: 0, appliedBlocks: 0, beforeSha256: null, afterSha256: "y" },
      false,
    );
    expect("error" in created).toBe(false);
    if (!("error" in created)) {
      expect(created.right).toBe(join(hdir, "after", "sub/new.ts"));
      expect(created.left).not.toBe(join(hdir, "before", "sub/new.ts")); // 空ファイル代替
    }

    const mine = resolveDiffPair(
      dir,
      hdir,
      { path: "legacy.vb", op: "replace", applied: true, blocks: 1, appliedBlocks: 1, beforeSha256: "x", afterSha256: "y" },
      true,
    );
    expect(mine).toMatchObject({ right: join(dir, "legacy.vb") });

    const mineDeleted = resolveDiffPair(
      dir,
      hdir,
      { path: "old.txt", op: "delete", applied: true, blocks: 0, appliedBlocks: 0, beforeSha256: "x", afterSha256: null },
      true,
    );
    expect("error" in mineDeleted).toBe(true);
  });
});
