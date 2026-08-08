import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("initCommand (§4.6)", () => {
  it("--yes で config / protocol.md / repomix.config.json / .gitignore を一括生成する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-init-"));
    expect(await initCommand(["--root", dir, "--yes"])).toBe(0);

    expect(existsSync(join(dir, ".petari", "config.json"))).toBe(true);
    expect(readFileSync(join(dir, "protocol.md"), "utf8")).toBe(PROTOCOL_TEXT);
    expect(JSON.parse(readFileSync(join(dir, "repomix.config.json"), "utf8"))).toEqual({
      output: { instructionFilePath: "protocol.md" },
    });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".petari/\n");
  });

  it("再実行しても既存ファイルを壊さない (冪等)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-init2-"));
    await initCommand(["--root", dir, "--yes"]);
    const config1 = readFileSync(join(dir, ".petari", "config.json"), "utf8");
    await initCommand(["--root", dir, "--yes"]);
    expect(readFileSync(join(dir, ".petari", "config.json"), "utf8")).toBe(config1);
    // .gitignore の重複追記もない
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".petari/\n");
  });

  it("既存の repomix.config.json には instructionFilePath を追記し他のキーを保持する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-init3-"));
    writeFileSync(
      join(dir, "repomix.config.json"),
      JSON.stringify({ output: { style: "xml" }, ignore: { customPatterns: ["*.log"] } }, null, 2),
      "utf8",
    );
    await initCommand(["--root", dir, "--yes"]);
    const config = JSON.parse(readFileSync(join(dir, "repomix.config.json"), "utf8")) as {
      output: { style: string; instructionFilePath: string };
      ignore: { customPatterns: string[] };
    };
    expect(config.output.style).toBe("xml");
    expect(config.output.instructionFilePath).toBe("protocol.md");
    expect(config.ignore.customPatterns).toEqual(["*.log"]);
  });

  it("既存 .gitignore には末尾に追記する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-init4-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await initCommand(["--root", dir, "--yes"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.petari/\n");
  });

  it("古い protocol.md は更新される", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-init5-"));
    writeFileSync(join(dir, "protocol.md"), "<!-- petari protocol v0 -->\n古い規約", "utf8");
    await initCommand(["--root", dir, "--yes"]);
    expect(readFileSync(join(dir, "protocol.md"), "utf8")).toBe(PROTOCOL_TEXT);
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
