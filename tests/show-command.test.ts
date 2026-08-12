import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { cleanupOldReports, generateReportHtml, showCommand } from "../src/commands/show.ts";
import { listHistoryIds, type Manifest, type ManifestFileEntry } from "../src/infra/history.ts";
import type { Operation } from "../src/types.ts";

// 注: --edit --browser の正常系サーバー経路は closed を await してブロックするため
// showCommand 経由では検証しない (tests/diff-server.test.ts が全経路をカバーする)

const doc = (...lines: string[]): string => lines.join("\n");

const simpleChanges = (path: string): string =>
  doc(
    "## CHANGES",
    "概要",
    `### FILE: ${path} (replace)`,
    "<<<<<<< SEARCH",
    "hello",
    "=======",
    "goodbye",
    ">>>>>>> REPLACE",
  );

async function setupApplied(): Promise<{ root: string; id: string }> {
  const root = mkdtempSync(join(tmpdir(), "petari-show-cmd-"));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const changesPath = join(root, "changes.md");
  writeFileSync(changesPath, simpleChanges("a.txt"), "utf8");
  expect(await applyCommand([changesPath, "--root", root, "--yes"])).toBe(0);
  const id = listHistoryIds(root)[0] as string;
  return { root, id };
}

const entry = (path: string, op: Operation): ManifestFileEntry => ({
  path,
  op,
  applied: true,
  blocks: 0,
  appliedBlocks: 0,
  beforeSha256: null,
  afterSha256: null,
});

describe("showCommand: ブラウザ経路 (§4.3)", () => {
  it("--browser --no-open はレポートを書き出して 0 を返す", async () => {
    const { root } = await setupApplied();
    expect(await showCommand(["--root", root, "--browser", "--no-open"])).toBe(0);
  });

  it("vscodeCommand が見つからない場合はブラウザレポートにフォールバックして 0", async () => {
    const { root } = await setupApplied();
    writeFileSync(
      join(root, ".petari", "config.json"),
      JSON.stringify({ vscodeCommand: "petari-test-no-such-cmd" }),
      "utf8",
    );
    expect(await showCommand(["--root", root, "--no-open"])).toBe(0);
  });

  it("コマンドが存在するが起動失敗した場合はフォールバックせず 1 (従来挙動)", async () => {
    const { root } = await setupApplied();
    // POSIX の false は必ず終了コード 1 (ENOENT/EINVAL ではない)
    writeFileSync(
      join(root, ".petari", "config.json"),
      JSON.stringify({ vscodeCommand: "false" }),
      "utf8",
    );
    expect(await showCommand(["--root", root, "--no-open"])).toBe(1);
  });

  it("--file が履歴にないパスなら 1", async () => {
    const { root } = await setupApplied();
    expect(await showCommand(["--root", root, "--browser", "--no-open", "--file", "zzz.txt"])).toBe(1);
  });
});

describe("showCommand: manifest 改ざん耐性 (§9)", () => {
  const tamper = (root: string, id: string, path: string): void => {
    const mpath = join(root, ".petari", "history", id, "manifest.json");
    const manifest = JSON.parse(readFileSync(mpath, "utf8")) as Manifest;
    (manifest.files[0] as ManifestFileEntry).path = path;
    writeFileSync(mpath, JSON.stringify(manifest), "utf8");
  };

  it("パス改ざん (../) は --edit で拒否する", async () => {
    const { root, id } = await setupApplied();
    tamper(root, id, "../evil.txt");
    expect(await showCommand(["--root", root, "--edit", "--browser", "--no-open"])).toBe(1);
  });

  it("パス改ざん (../) は閲覧レポートでも拒否する (読み取りにも適用)", async () => {
    const { root, id } = await setupApplied();
    tamper(root, id, "../evil.txt");
    expect(await showCommand(["--root", root, "--browser", "--no-open"])).toBe(1);
  });
});

describe("cleanupOldReports (§4.3)", () => {
  it("1 時間より古いレポートだけを削除し、直近分と他の接頭辞は残す", () => {
    const oldDir = mkdtempSync(join(tmpdir(), "petari-report-"));
    writeFileSync(join(oldDir, "report.html"), "<html>old</html>");
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(oldDir, past, past);

    const freshDir = mkdtempSync(join(tmpdir(), "petari-report-"));
    const otherDir = mkdtempSync(join(tmpdir(), "petari-other-"));
    utimesSync(otherDir, past, past);

    cleanupOldReports();
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(otherDir)).toBe(true);
  });
});

describe("generateReportHtml (§4.3)", () => {
  it("replace / create / delete / バイナリを 1 ページに描画する", () => {
    const root = mkdtempSync(join(tmpdir(), "petari-show-rep-"));
    const hdir = join(root, ".petari", "history", "X");
    mkdirSync(join(hdir, "before"), { recursive: true });
    mkdirSync(join(hdir, "after"), { recursive: true });
    writeFileSync(join(hdir, "before", "a.txt"), "old line\n");
    writeFileSync(join(hdir, "after", "a.txt"), "new line\n");
    writeFileSync(join(hdir, "after", "c.txt"), "created\n");
    writeFileSync(join(hdir, "before", "d.txt"), "deleted\n");
    writeFileSync(join(hdir, "before", "bin.dat"), Uint8Array.of(0xff, 0xfe, 0x00, 0x41));
    writeFileSync(join(hdir, "after", "bin.dat"), Uint8Array.of(0xff, 0xfe, 0x00, 0x42));

    const html = generateReportHtml(
      root,
      hdir,
      "X",
      [entry("a.txt", "replace"), entry("c.txt", "create"), entry("d.txt", "delete"), entry("bin.dat", "rewrite")],
      false,
    );
    // 変更文字 (old/new) は文字単位ハイライトの span で囲まれる
    expect(html).toContain(`<span class="hl">old</span> line`);
    expect(html).toContain(`<span class="hl">new</span> line`);
    expect(html).toContain("created");
    expect(html).toContain("deleted");
    expect(html).toContain("差分を表示できません");
    expect(html).toContain("4 ファイル");
  });

  it("--mine で delete は注記、現在ファイル欠損も注記になる", () => {
    const root = mkdtempSync(join(tmpdir(), "petari-show-rep2-"));
    const hdir = join(root, ".petari", "history", "X");
    mkdirSync(join(hdir, "after"), { recursive: true });
    writeFileSync(join(hdir, "after", "gone.txt"), "x\n");

    const html = generateReportHtml(
      root,
      hdir,
      "X",
      [entry("d.txt", "delete"), entry("gone.txt", "replace")],
      true,
    );
    expect(html).toContain("--mine の比較対象がありません");
    expect(html).toContain("現在存在しません");
  });
});
