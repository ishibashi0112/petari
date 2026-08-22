import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { invalidVscodeCommandReason, showCommand } from "../src/commands/show.ts";
import { undoCommand } from "../src/commands/undo.ts";
import { invalidPathReason } from "../src/core/applier.ts";
import { isInsideRoot } from "../src/infra/files.ts";
import { listHistoryIds, readManifest, type Manifest } from "../src/infra/history.ts";
import { sanitizeForTerminal } from "../src/infra/term.ts";

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

describe("invalidPathReason: Windows 特殊パス (指摘 6)", () => {
  it("代替データストリーム (:) を拒否する", () => {
    expect(invalidPathReason("src/a.txt:stream")).not.toBeNull();
  });
  it("予約デバイス名を拒否する (拡張子付き・大文字小文字問わず)", () => {
    expect(invalidPathReason("CON")).not.toBeNull();
    expect(invalidPathReason("src/nul.txt")).not.toBeNull();
    expect(invalidPathReason("src/COM1")).not.toBeNull();
    expect(invalidPathReason("lpt9.vb")).not.toBeNull();
  });
  it("紛らわしいが正当な名前は許可する", () => {
    expect(invalidPathReason("src/console.ts")).toBeNull();
    expect(invalidPathReason("src/nullable.vb")).toBeNull();
    expect(invalidPathReason("com10/x.ts")).toBeNull();
  });
  it("末尾ドット/空白での予約名バイパスを拒否する (Windows は末尾を無視して解釈)", () => {
    expect(invalidPathReason("src/con.")).not.toBeNull();
    expect(invalidPathReason("src/aux.txt ")).not.toBeNull();
    expect(invalidPathReason("nul...")).not.toBeNull();
  });
});

describe("symlink ディレクトリ経由のルート外書き込み防止 (指摘 2)", () => {
  it("isInsideRoot は symlink 経由の外部パスを検出する", () => {
    const root = mkdtempSync(join(tmpdir(), "petari-sec-root-"));
    const outside = mkdtempSync(join(tmpdir(), "petari-sec-out-"));
    symlinkSync(outside, join(root, "linkdir"));
    mkdirSync(join(root, "realdir"));

    expect(isInsideRoot(root, join(root, "realdir", "a.txt"))).toBe(true);
    expect(isInsideRoot(root, join(root, "a.txt"))).toBe(true);
    expect(isInsideRoot(root, join(root, "new", "deep", "a.txt"))).toBe(true); // 未作成の深い階層
    expect(isInsideRoot(root, join(root, "linkdir", "a.txt"))).toBe(false);
  });

  it("apply は symlink 経由の変更を検証段階で失敗させ、外部ファイルを守る", async () => {
    const root = mkdtempSync(join(tmpdir(), "petari-sec-a-"));
    const outside = mkdtempSync(join(tmpdir(), "petari-sec-b-"));
    writeFileSync(join(outside, "target.txt"), "hello\n");
    symlinkSync(outside, join(root, "linkdir"));
    // 失敗レポートの自動コピーがテスト実行機のクリップボードを書き換えないよう無効化
    mkdirSync(join(root, ".petari"), { recursive: true });
    writeFileSync(
      join(root, ".petari", "config.json"),
      JSON.stringify({ clipReportOnFailure: false }),
      "utf8",
    );
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("linkdir/target.txt"), "utf8");

    const code = await applyCommand([changesPath, "--root", root, "--yes"]);
    expect(code).toBe(1);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("hello\n");
    expect(listHistoryIds(root)).toHaveLength(0);
  });
});

describe("undo は改ざんされた manifest を拒否する (指摘 1)", () => {
  async function setupApplied(): Promise<{ root: string; manifestPath: string; manifest: Manifest }> {
    const root = mkdtempSync(join(tmpdir(), "petari-sec-undo-"));
    writeFileSync(join(root, "a.txt"), "hello\n");
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("a.txt"), "utf8");
    expect(await applyCommand([changesPath, "--root", root, "--yes"])).toBe(0);
    const id = listHistoryIds(root)[0] as string;
    const manifestPath = join(root, ".petari", "history", id, "manifest.json");
    const manifest = readManifest(root, id) as Manifest;
    return { root, manifestPath, manifest };
  }

  it("パストラバーサル (../) を含む manifest で undo しない", async () => {
    const { root, manifestPath, manifest } = await setupApplied();
    (manifest.files[0] as { path: string }).path = "../evil.txt";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(await undoCommand(["--root", root, "--yes"])).toBe(1);
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
  });

  it("絶対パスを含む manifest で undo しない", async () => {
    const { root, manifestPath, manifest } = await setupApplied();
    (manifest.files[0] as { path: string }).path = "/tmp/evil.txt";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(await undoCommand(["--root", root, "--yes"])).toBe(1);
  });
});

describe("vscodeCommand の形式制限 (指摘 3)", () => {
  it("相対パス・UNC を拒否し、コマンド名と絶対パスを許可する", () => {
    expect(invalidVscodeCommandReason("./evil.sh")).not.toBeNull();
    expect(invalidVscodeCommandReason("scripts\\evil.cmd")).not.toBeNull();
    expect(invalidVscodeCommandReason("\\\\server\\share\\evil.exe")).not.toBeNull();
    expect(invalidVscodeCommandReason("//server/share/evil")).not.toBeNull();
    expect(invalidVscodeCommandReason("")).not.toBeNull();
    expect(invalidVscodeCommandReason("code")).toBeNull();
    expect(invalidVscodeCommandReason("code-insiders")).toBeNull();
    expect(invalidVscodeCommandReason("/usr/local/bin/code")).toBeNull();
  });

  it("show は不正な vscodeCommand を実行前に拒否する", async () => {
    const root = mkdtempSync(join(tmpdir(), "petari-sec-show-"));
    writeFileSync(join(root, "a.txt"), "hello\n");
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("a.txt"), "utf8");
    expect(await applyCommand([changesPath, "--root", root, "--yes"])).toBe(0);
    writeFileSync(
      join(root, ".petari", "config.json"),
      JSON.stringify({ vscodeCommand: "./evil.sh" }),
      "utf8",
    );
    expect(await showCommand(["--root", root])).toBe(1);
  });
});

describe("sanitizeForTerminal (指摘 4)", () => {
  it("ANSI エスケープと C0/C1 制御文字を除去し、改行とタブは保持する", () => {
    expect(sanitizeForTerminal("\u001b[31m赤\u001b[0m")).toBe("[31m赤[0m");
    expect(sanitizeForTerminal("a\u0007b\u0000c\u009bd")).toBe("abcd");
    expect(sanitizeForTerminal("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it("双方向制御文字 (Trojan Source) を除去する", () => {
    expect(sanitizeForTerminal("a\u202egnp.exe")).toBe("agnp.exe");
    expect(sanitizeForTerminal("x\u2066y\u2069z\u200f")).toBe("xyz");
  });
});

describe("config の実行時検証 (指摘 5 追補)", () => {
  it("不正な newFile.encoding / historyLimit は明確なエラーになる", async () => {
    const { loadConfig } = await import("../src/infra/config.ts");
    const root = mkdtempSync(join(tmpdir(), "petari-sec-cfg-"));
    mkdirSync(join(root, ".petari"));
    writeFileSync(
      join(root, ".petari", "config.json"),
      JSON.stringify({ newFile: { encoding: "utf16" } }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/newFile\.encoding/);

    writeFileSync(
      join(root, ".petari", "config.json"),
      JSON.stringify({ historyLimit: -5 }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/historyLimit/);
  });
});
