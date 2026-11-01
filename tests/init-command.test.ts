import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_TEXT } from "../src/assets/protocol.ts";
import { initCommand } from "../src/commands/init.ts";
import { pruneHistory } from "../src/infra/history.ts";
import { beginHistory, finishHistory, listHistoryIds, type Manifest } from "../src/infra/history.ts";

const manifest = (id: string): Manifest => ({
  id,
  appliedAt: "2026-08-08T00:00:00.000Z",
  success: true,
  partial: false,
  source: { type: "file" },
  files: [],
});

describe("initCommand (§4.6、設計書 §25 の一本化)", () => {
  /** .git と .sln のある空のリポジトリ */
  const repo = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "App.sln"), "", "utf8");
    return dir;
  };

  it("対話なしで .petari/config.json・設定ファイル・docs/・.gitignore を作る (protocol.md / repomix.config.json は作らない)", async () => {
    const dir = repo("petari-init-");
    expect(await initCommand(["--root", dir])).toBe(0);

    // 雛形の既定は newFile.encoding "auto" と vbproj 登録あり (設計書 §11)
    const config = JSON.parse(readFileSync(join(dir, ".petari", "config.json"), "utf8")) as {
      newFile: { encoding: string };
      vbproj: { register: boolean };
    };
    expect(config.newFile).toEqual({ encoding: "auto" });
    expect(config.vbproj).toEqual({ register: true });
    expect(existsSync(join(dir, "petari.config.json"))).toBe(true);
    expect(existsSync(join(dir, "docs", "README.md"))).toBe(true);
    expect(existsSync(join(dir, "protocol.md"))).toBe(false);
    expect(existsSync(join(dir, "repomix.config.json"))).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "repomix-output.xml\nrepomix-output.prompt.md\n.petari/\n",
    );
  });

  // 旧 slnmix init が --yes --no-repomix で呼ぶ。受け付けて無視する
  it("--yes / --no-repomix は受け付けて無視する", async () => {
    const dir = repo("petari-init-compat-");
    expect(await initCommand(["--root", dir, "--yes", "--no-repomix"])).toBe(0);
    expect(existsSync(join(dir, ".petari", "config.json"))).toBe(true);
    expect(existsSync(join(dir, "repomix.config.json"))).toBe(false);
  });

  it("2 回目は何も変えない (冪等)", async () => {
    const dir = repo("petari-init2-");
    await initCommand(["--root", dir]);
    const snapshot = (): string[] =>
      [".petari/config.json", "petari.config.json", ".gitignore", "docs/README.md"].map((p) =>
        readFileSync(join(dir, p), "utf8"),
      );
    const first = snapshot();
    expect(await initCommand(["--root", dir])).toBe(0);
    expect(snapshot()).toEqual(first);
  });

  it("既存の protocol.md・.gitignore は変えず、.gitignore には末尾に追記する", async () => {
    const dir = repo("petari-init4-");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
    writeFileSync(join(dir, "protocol.md"), PROTOCOL_TEXT, "utf8");
    await initCommand(["--root", dir]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\nrepomix-output.xml\nrepomix-output.prompt.md\n.petari/\n",
    );
    expect(readFileSync(join(dir, "protocol.md"), "utf8")).toBe(PROTOCOL_TEXT);
  });

  it("--root がなければカレントから上に向かってルートを決める (.git の場所)", async () => {
    const dir = repo("petari-init5-");
    const sub = join(dir, "src");
    mkdirSync(sub);
    const cwd = process.cwd();
    try {
      process.chdir(sub);
      expect(await initCommand([])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(join(dir, ".petari", "config.json"))).toBe(true);
    expect(existsSync(join(sub, ".petari"))).toBe(false);
  });
});

describe("pruneHistory (§10 historyLimit)", () => {
  it("上限を超えた古い履歴から削除する", () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-prune-"));
    for (const id of ["2026-08-01_0900", "2026-08-02_0900", "2026-08-03_0900"]) {
      beginHistory(dir, id, "## CHANGES\nx", new Map());
      finishHistory(dir, id, manifest(id), new Map());
    }
    const pruned = pruneHistory(dir, 2);
    expect(pruned).toEqual(["2026-08-01_0900"]);
    expect(listHistoryIds(dir)).toEqual(["2026-08-02_0900", "2026-08-03_0900"]);
    // null は無制限
    expect(pruneHistory(dir, null)).toEqual([]);
    expect(listHistoryIds(dir)).toHaveLength(2);
  });
});
