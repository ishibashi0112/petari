/**
 * 旧名 (petari) で使っていたリポジトリ・PC をそのまま引き継げることの確認 (設計書 §25.8-1、2026-11-01 改名)。
 * - .petari/ だけがあるリポジトリは .petari/ を使い続ける (履歴・PC ごとの設定。.tazuna/ を作らない)
 * - グローバル設定は tazuna/config.json が無ければ旧版の petari/config.json
 * - 旧 init が書いた protocol.md (1 行目が `<!-- petari protocol v4 -->`) は手を加えていなければ内蔵の版とみなす
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_TEXT, PROTOCOL_VERSION } from "../src/assets/protocol.ts";
import { LEGACY_STATE_DIRECTORY, STATE_DIRECTORY, stateDirectoryName } from "../src/brand.ts";
import { applyCommand } from "../src/commands/apply.ts";
import { initCommand } from "../src/commands/init.ts";
import { globalConfigPath, loadConfig } from "../src/infra/config.ts";
import { builtinProtocolVersionOf, protocolVersionOf } from "../src/pack/instructionFile.ts";

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

describe("stateDirectoryName", () => {
  const dirs = (...names: string[]) => (p: string) => names.some((n) => p === join("/repo", n));

  it("どちらも無ければ新しい名前 (.tazuna)", () => {
    expect(STATE_DIRECTORY).toBe(".tazuna");
    expect(stateDirectoryName("/repo", dirs())).toBe(".tazuna");
  });

  it("旧名 (.petari) だけがあれば旧名", () => {
    expect(LEGACY_STATE_DIRECTORY).toBe(".petari");
    expect(stateDirectoryName("/repo", dirs(".petari"))).toBe(".petari");
  });

  it("両方あれば新しい名前", () => {
    expect(stateDirectoryName("/repo", dirs(".petari", ".tazuna"))).toBe(".tazuna");
  });
});

describe("旧版の .petari/ を使い続ける", () => {
  /** petari init 済みのリポジトリ (.petari/config.json と .gitignore の .petari/) */
  const legacyRepo = (): string => {
    const dir = tempDir("tazuna-legacy-");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".petari"));
    // 失敗レポートの自動コピーでテスト実行機のクリップボードを書き換えないよう無効化する
    writeFileSync(join(dir, ".petari", "config.json"), JSON.stringify({ clipReportOnFailure: false, historyLimit: 7 }));
    writeFileSync(join(dir, ".gitignore"), ".petari/\n");
    return dir;
  };

  it("適用の履歴は .petari/history に書き、.tazuna/ を作らない", async () => {
    const dir = legacyRepo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    const changes = join(tempDir("tazuna-legacy-changes-"), "changes.md");
    writeFileSync(
      changes,
      ["## CHANGES", "", "one を two に。", "", "### FILE: a.txt (replace)", "<<<<<<< SEARCH", "one", "=======", "two", ">>>>>>> REPLACE", ""].join("\n"),
    );
    expect(await applyCommand([changes, "--root", dir, "--yes"])).toBe(0);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n");
    expect(readdirSync(join(dir, ".petari", "history"))).toHaveLength(1);
    expect(existsSync(join(dir, ".tazuna"))).toBe(false);
  });

  it("PC ごとの設定は .petari/config.json を読む", () => {
    const dir = legacyRepo();
    expect(loadConfig(dir).historyLimit).toBe(7);
  });

  it("init は .petari/ をそのまま使い、.tazuna/ を作らない", async () => {
    const dir = legacyRepo();
    writeFileSync(join(dir, "App.sln"), "");
    expect(await initCommand(["--root", dir])).toBe(0);
    expect(existsSync(join(dir, ".tazuna"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".petari", "config.json"), "utf8"))).toEqual({
      clipReportOnFailure: false,
      historyLimit: 7,
    });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      ".petari/\nrepomix-output.xml\nrepomix-output.prompt.md\n",
    );
  });
});

describe.skipIf(process.platform === "win32")("グローバル設定の旧名", () => {
  const saved = process.env["XDG_CONFIG_HOME"];
  afterEach(() => {
    if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = saved;
  });

  it("tazuna/config.json が無く petari/config.json があれば旧名を読む", () => {
    const base = tempDir("tazuna-xdg-");
    process.env["XDG_CONFIG_HOME"] = base;
    expect(globalConfigPath()).toBe(join(base, "tazuna", "config.json"));
    mkdirSync(join(base, "petari"));
    writeFileSync(join(base, "petari", "config.json"), "{}");
    expect(globalConfigPath()).toBe(join(base, "petari", "config.json"));
    mkdirSync(join(base, "tazuna"));
    writeFileSync(join(base, "tazuna", "config.json"), "{}");
    expect(globalConfigPath()).toBe(join(base, "tazuna", "config.json"));
  });
});

describe("規約文の旧名", () => {
  it("v5 は 1 行目のツール名を変えただけ (旧 init が書いた v4 は手を加えていなければ内蔵の第 4 版)", () => {
    expect(PROTOCOL_VERSION).toBe(5);
    expect(PROTOCOL_TEXT.startsWith("<!-- tazuna protocol v5 -->\n")).toBe(true);
    const v4 = PROTOCOL_TEXT.replace("<!-- tazuna protocol v5 -->", "<!-- petari protocol v4 -->");
    expect(builtinProtocolVersionOf(v4)).toBe(4);
    expect(builtinProtocolVersionOf(v4.replace(/\n/g, "\r\n"))).toBe(4);
    expect(builtinProtocolVersionOf(PROTOCOL_TEXT)).toBe(5);
  });

  it("1 行目の版は新旧どちらの名前でも読む", () => {
    expect(protocolVersionOf("<!-- tazuna protocol v5 -->\n本文")).toBe(5);
    expect(protocolVersionOf("<!-- petari protocol v3 -->\n本文")).toBe(3);
    expect(protocolVersionOf("<!-- slnmix protocol v3 -->\n本文")).toBeUndefined();
  });
});
