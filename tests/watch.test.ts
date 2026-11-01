import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchCommand } from "../src/commands/watch.ts";
import { hasChangesHeading } from "../src/core/parser.ts";
import { initialWatchState, observeWatch, type WatchedFile } from "../src/core/watch.ts";
import type { Manifest } from "../src/infra/history.ts";

const f = (path: string, mtimeMs: number, size = 10): WatchedFile => ({ path, mtimeMs, size });

describe("observeWatch (§4.7 新着検出)", () => {
  it("開始時に既にあるファイルは渡さない", () => {
    const state = initialWatchState([f("a.md", 1)]);
    expect(observeWatch(state, [f("a.md", 1)])).toEqual([]);
    expect(observeWatch(state, [f("a.md", 1)])).toEqual([]);
  });

  it("新着は同じ時刻・サイズを 2 回続けて観測してから 1 度だけ渡す", () => {
    const state = initialWatchState([]);
    expect(observeWatch(state, [f("b.md", 5, 3)])).toEqual([]);
    // 書き込み中 (サイズが伸びている) はまだ渡さない
    expect(observeWatch(state, [f("b.md", 6, 8)])).toEqual([]);
    expect(observeWatch(state, [f("b.md", 6, 8)])).toEqual([f("b.md", 6, 8)]);
    expect(observeWatch(state, [f("b.md", 6, 8)])).toEqual([]);
  });

  it("0 バイトのファイルは渡さない (Firefox が先に作る空ファイル)", () => {
    const state = initialWatchState([]);
    expect(observeWatch(state, [f("c.md", 1, 0)])).toEqual([]);
    expect(observeWatch(state, [f("c.md", 1, 0)])).toEqual([]);
    expect(observeWatch(state, [f("c.md", 2, 40)])).toEqual([]);
    expect(observeWatch(state, [f("c.md", 2, 40)])).toEqual([f("c.md", 2, 40)]);
  });

  it("渡したファイルは内容が変わったら、既存のファイルも更新されたら渡し直す", () => {
    const state = initialWatchState([f("old.md", 1)]);
    observeWatch(state, [f("old.md", 1), f("d.md", 2)]);
    expect(observeWatch(state, [f("old.md", 1), f("d.md", 2)])).toEqual([f("d.md", 2)]);
    observeWatch(state, [f("old.md", 9), f("d.md", 3)]);
    expect(observeWatch(state, [f("old.md", 9), f("d.md", 3)])).toEqual([f("d.md", 3), f("old.md", 9)]);
  });

  it("消えたファイルは忘れ、同じ名前で現れたら新着として扱う", () => {
    const state = initialWatchState([f("e.md", 1)]);
    expect(observeWatch(state, [])).toEqual([]);
    observeWatch(state, [f("e.md", 1)]);
    expect(observeWatch(state, [f("e.md", 1)])).toEqual([f("e.md", 1)]);
  });

  it("同時に届いたものは古い順に渡す", () => {
    const state = initialWatchState([]);
    const files = [f("new.md", 20), f("older.md", 10)];
    observeWatch(state, files);
    expect(observeWatch(state, files).map((x) => x.path)).toEqual(["older.md", "new.md"]);
  });
});

describe("hasChangesHeading", () => {
  it("## CHANGES と寛容パースのレベル違いを認め、変更履歴の見出しは認めない", () => {
    expect(hasChangesHeading("前置き\n## CHANGES\n")).toBe(true);
    expect(hasChangesHeading("### CHANGES\r\n")).toBe(true);
    expect(hasChangesHeading("# Changelog\n## [1.0.0]\n- CHANGES: 修正\n")).toBe(false);
  });
});

const CHANGES = [
  "## CHANGES",
  "",
  "カウンタの初期値を変更。",
  "",
  "### FILE: legacy.vb (replace)",
  "<<<<<<< SEARCH",
  "Dim count As Integer = 1",
  "=======",
  "Dim count As Integer = 100",
  ">>>>>>> REPLACE",
  "",
].join("\n");

const FAILING = CHANGES.replace("Dim count As Integer = 1\n", "Dim missing As Integer = 1\n");

describe("watchCommand (§4.7)", () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    const capture = (chunk: unknown): boolean => {
      output.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup(): { dir: string; downloads: string } {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-watch-"));
    const downloads = mkdtempSync(join(tmpdir(), "tazuna-watch-dl-"));
    writeFileSync(join(dir, "legacy.vb"), "Module M\nDim count As Integer = 1\nEnd Module\n", "utf8");
    mkdirSync(join(dir, ".tazuna"), { recursive: true });
    writeFileSync(
      join(dir, ".tazuna", "config.json"),
      JSON.stringify({ downloadsDir: downloads, clipReportOnFailure: false }),
      "utf8",
    );
    return { dir, downloads };
  }

  async function waitFor(cond: () => boolean, label: string): Promise<void> {
    const until = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > until) throw new Error(`timeout: ${label}\n${output.join("")}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 監視を始め、開始時の一覧を取り終えるまで待つ */
  async function start(dir: string): Promise<{ stop: () => Promise<number> }> {
    const ac = new AbortController();
    const running = watchCommand(["--root", dir], { signal: ac.signal, intervalMs: 10 });
    await waitFor(() => output.join("").includes("到着を待っています"), "start");
    return {
      stop: async () => {
        ac.abort();
        return running;
      },
    };
  }

  const count = (needle: string): number => output.join("").split(needle).length - 1;

  it("届いた changes.md を確認なしで適用し、Downloads から履歴へ移動する", async () => {
    const { dir, downloads } = setup();
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    await waitFor(() => !existsSync(join(downloads, "changes.md")), "applied");
    expect(await w.stop()).toBe(0);

    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 100");
    const ids = readdirSync(join(dir, ".tazuna", "history"));
    expect(ids).toHaveLength(1);
    const manifest = JSON.parse(
      readFileSync(join(dir, ".tazuna", "history", ids[0] as string, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.source).toEqual({ type: "downloads", path: join(downloads, "changes.md") });
    expect(output.join("")).toContain("監視を終了しました");
  });

  it("開始前からある changes.md は当てない", async () => {
    const { dir, downloads } = setup();
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    const w = await start(dir);
    await new Promise((r) => setTimeout(r, 100));
    expect(await w.stop()).toBe(0);
    expect(existsSync(join(downloads, "changes.md"))).toBe(true);
    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 1\n");
    expect(output.join("")).toContain("既にある 1 件は対象外");
  });

  it("失敗した changes.md は 1 度だけレポートし、次に届いたものは適用する", async () => {
    const { dir, downloads } = setup();
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), FAILING, "utf8");
    await waitFor(() => count("検証に失敗しました") === 1, "failed");
    await new Promise((r) => setTimeout(r, 100));
    expect(count("検証に失敗しました")).toBe(1);
    expect(existsSync(join(downloads, "changes.md"))).toBe(true);

    // ブラウザは同名があると "changes (1).md" で保存する
    writeFileSync(join(downloads, "changes (1).md"), CHANGES, "utf8");
    await waitFor(() => !existsSync(join(downloads, "changes (1).md")), "applied");
    expect(await w.stop()).toBe(0);
    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 100");
  });

  it("プロジェクト直下の CHANGES.md (変更履歴) は当てない", async () => {
    const { dir } = setup();
    const w = await start(dir);
    writeFileSync(join(dir, "CHANGES.md"), "# Changelog\n\n## 1.0.0\n- 初版\n", "utf8");
    await waitFor(() => output.join("").includes("見出しがないため"), "skipped");
    expect(await w.stop()).toBe(0);
    expect(existsSync(join(dir, "CHANGES.md"))).toBe(true);
    expect(existsSync(join(dir, ".tazuna", "history"))).toBe(false);
  });
});
