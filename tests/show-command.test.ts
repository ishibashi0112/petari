import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { cleanupOldReports, generateReportHtml, showCommand, vscodeMissingHint } from "../src/commands/show.ts";
import { listHistoryIds, type Manifest, type ManifestFileEntry } from "../src/infra/history.ts";
import type { Operation } from "../src/types.ts";

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
  const root = mkdtempSync(join(tmpdir(), "tazuna-show-cmd-"));
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
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ vscodeCommand: "tazuna-test-no-such-cmd" }),
      "utf8",
    );
    expect(await showCommand(["--root", root, "--no-open"])).toBe(0);
  });

  it("コマンドが存在するが起動失敗した場合はフォールバックせず 1 (従来挙動)", async () => {
    const { root } = await setupApplied();
    // POSIX の false は必ず終了コード 1 (ENOENT/EINVAL ではない)
    writeFileSync(
      join(root, ".tazuna", "config.json"),
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

describe("showCommand: --edit は VS Code 専用 (v0.13.0)", () => {
  it("--edit --browser はブラウザ編集の廃止を案内して 1", async () => {
    const { root } = await setupApplied();
    expect(await showCommand(["--root", root, "--edit", "--browser", "--no-open"])).toBe(1);
  });

  it("--edit で vscodeCommand が見つからない場合はブラウザにフォールバックせず 1", async () => {
    const { root } = await setupApplied();
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ vscodeCommand: "tazuna-test-no-such-cmd" }),
      "utf8",
    );
    expect(await showCommand(["--root", root, "--edit", "--no-open"])).toBe(1);
  });

  it("--edit は VS Code があれば差分を開いて 0", async () => {
    const { root } = await setupApplied();
    // POSIX の true は引数を無視して終了コード 0 (VS Code の代わり)
    writeFileSync(join(root, ".tazuna", "config.json"), JSON.stringify({ vscodeCommand: "true" }), "utf8");
    expect(await showCommand(["--root", root, "--edit"])).toBe(0);
  });
});

describe("vscodeMissingHint", () => {
  it("Windows で既定の code (code.cmd は起動できない) なら Code.exe の絶対パスを案内する", () => {
    expect(vscodeMissingHint("code", "win32")).toContain("Code.exe");
  });

  it("Windows でも絶対パスを設定済みなら案内しない", () => {
    expect(vscodeMissingHint("C:/Program Files/Microsoft VS Code/Code.exe", "win32")).toBeNull();
    expect(vscodeMissingHint("C:\\Tools\\Code.exe", "win32")).toBeNull();
  });

  it("Windows 以外では案内しない", () => {
    expect(vscodeMissingHint("code", "darwin")).toBeNull();
    expect(vscodeMissingHint("code", "linux")).toBeNull();
  });
});

describe("showCommand: manifest 改ざん耐性 (§9)", () => {
  const tamper = (root: string, id: string, path: string): void => {
    const mpath = join(root, ".tazuna", "history", id, "manifest.json");
    const manifest = JSON.parse(readFileSync(mpath, "utf8")) as Manifest;
    (manifest.files[0] as ManifestFileEntry).path = path;
    writeFileSync(mpath, JSON.stringify(manifest), "utf8");
  };

  it("パス改ざん (../) は --edit で拒否する", async () => {
    const { root, id } = await setupApplied();
    tamper(root, id, "../evil.txt");
    // 検証が無ければ true が 0 で終わるため、1 は改ざんの拒否による
    writeFileSync(join(root, ".tazuna", "config.json"), JSON.stringify({ vscodeCommand: "true" }), "utf8");
    expect(await showCommand(["--root", root, "--edit"])).toBe(1);
  });

  it("パス改ざん (../) は閲覧レポートでも拒否する (読み取りにも適用)", async () => {
    const { root, id } = await setupApplied();
    tamper(root, id, "../evil.txt");
    expect(await showCommand(["--root", root, "--browser", "--no-open"])).toBe(1);
  });
});

describe("cleanupOldReports (§4.3)", () => {
  it("1 時間より古いレポートだけを削除し、直近分と他の接頭辞は残す", () => {
    const oldDir = mkdtempSync(join(tmpdir(), "tazuna-report-"));
    writeFileSync(join(oldDir, "report.html"), "<html>old</html>");
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(oldDir, past, past);

    // 旧版 (petari) が残したレポートも消す (コードの中身を平文で含むため)
    const legacyDir = mkdtempSync(join(tmpdir(), "petari-report-"));
    utimesSync(legacyDir, past, past);

    const freshDir = mkdtempSync(join(tmpdir(), "tazuna-report-"));
    const otherDir = mkdtempSync(join(tmpdir(), "tazuna-other-"));
    utimesSync(otherDir, past, past);

    cleanupOldReports();
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(otherDir)).toBe(true);
  });
});

describe("generateReportHtml (§4.3)", () => {
  it("replace / create / delete / バイナリを 1 ページに描画する", () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-show-rep-"));
    const hdir = join(root, ".tazuna", "history", "X");
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
    const root = mkdtempSync(join(tmpdir(), "tazuna-show-rep2-"));
    const hdir = join(root, ".tazuna", "history", "X");
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
