import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { undoCommand } from "../src/commands/undo.ts";
import { sjisEncode } from "../src/core/sjis.ts";
import type { Manifest } from "../src/infra/history.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sjis = (s: string): Uint8Array => sjisEncode(s).bytes;
const doc = (...lines: string[]): string => lines.join("\n");

function setupProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "petari-test-"));
  writeFileSync(join(dir, "legacy.vb"), sjis("' コメント\r\nDim count As Integer = 1\r\nEnd Module"));
  writeFileSync(join(dir, "old.txt"), utf8("obsolete\n"));
  // 失敗レポートの自動コピー (clipReportOnFailure 既定 true) がテスト実行機の
  // クリップボードを書き換えないよう無効化しておく
  mkdirSync(join(dir, ".petari"), { recursive: true });
  writeFileSync(
    join(dir, ".petari", "config.json"),
    JSON.stringify({ clipReportOnFailure: false }),
    "utf8",
  );
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

describe("applyCommand: 冪等性 (適用済み検出)", () => {
  it("同じ changes.md の再実行は全ブロック適用済みとして正常終了する (書き込み・履歴なし)", async () => {
    const dir = setupProject();
    const changesPath = join(dir, "changes.md");
    writeFileSync(changesPath, CHANGES, "utf8");

    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    const afterFirst = new Uint8Array(readFileSync(join(dir, "legacy.vb")));

    // 2 回目: replace は REPLACE 済み、create は既存内容一致、delete は既に無い
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "legacy.vb")))).toEqual(afterFirst);
    expect(historyIds(dir)).toHaveLength(1); // 2 回目は履歴を作らない
  });

  it("適用済みブロックと未適用ブロックの混在: 未適用分だけ適用し全体は成功する", async () => {
    const dir = setupProject();
    // ブロック 1 (count = 100) は適用済みの状態にしておく
    writeFileSync(
      join(dir, "legacy.vb"),
      sjis("' コメント\r\nDim count As Integer = 100\r\nEnd Module"),
    );
    const changesPath = join(dir, "changes.md");
    writeFileSync(
      changesPath,
      doc(
        "## CHANGES",
        "",
        "混在テスト。",
        "",
        "### FILE: legacy.vb (replace)",
        "<<<<<<< SEARCH",
        "Dim count As Integer = 1",
        "=======",
        "Dim count As Integer = 100",
        ">>>>>>> REPLACE",
        "",
        "<<<<<<< SEARCH",
        "End Module",
        "=======",
        "' done",
        "End Module",
        ">>>>>>> REPLACE",
      ),
      "utf8",
    );

    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "legacy.vb")))).toEqual(
      sjis("' コメント\r\nDim count As Integer = 100\r\n' done\r\nEnd Module"),
    );
    const ids = historyIds(dir);
    const manifest = JSON.parse(
      readFileSync(join(dir, ".petari", "history", ids[0] as string, "manifest.json"), "utf8"),
    ) as Manifest;
    const legacy = manifest.files.find((f) => f.path === "legacy.vb");
    expect(legacy?.appliedBlocks).toBe(1);
    expect(legacy?.alreadyAppliedBlocks).toEqual([1]);
  });
});

describe("applyCommand: プロジェクト直下の changes.md 検出", () => {
  it("引数なしで直下の changes.md を検出・適用し、履歴へ移動 (削除) する", async () => {
    const dir = setupProject();
    const emptyDownloads = mkdtempSync(join(tmpdir(), "petari-dl-"));
    mkdirSync(join(dir, ".petari"), { recursive: true });
    writeFileSync(
      join(dir, ".petari", "config.json"),
      JSON.stringify({ downloadsDir: emptyDownloads, clipReportOnFailure: false }),
      "utf8",
    );
    writeFileSync(join(dir, "changes.md"), CHANGES, "utf8");

    expect(await applyCommand(["--root", dir, "--yes"])).toBe(0);
    expect(existsSync(join(dir, "sub", "new.ts"))).toBe(true);
    expect(existsSync(join(dir, "changes.md"))).toBe(false); // 原本は履歴に保存済み

    const ids = historyIds(dir);
    const manifest = JSON.parse(
      readFileSync(join(dir, ".petari", "history", ids[0] as string, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.source.type).toBe("project-root");
    expect(
      readFileSync(join(dir, ".petari", "history", ids[0] as string, "changes.md"), "utf8"),
    ).toBe(CHANGES);
  });
});

describe("applyCommand: 二重適用の防止 (§6.1)", () => {
  const FORM = "Sub A()\n    Me.Close()\nEnd Sub\nEnd Class\n";
  const APPENDED = "Sub A()\n    Me.Close()\nEnd Sub\n\nPrivate Sub Foo()\n    Bar()\nEnd Sub\nEnd Class\n";
  // 追記型: SEARCH の後ろに新しい Sub を足す (適用後も SEARCH が一致し続ける)
  const APPEND_CHANGES = doc(
    "## CHANGES",
    "",
    "Foo を追加。",
    "",
    "### FILE: Form1.vb (replace)",
    "<<<<<<< SEARCH",
    "    Me.Close()",
    "End Sub",
    "=======",
    "    Me.Close()",
    "End Sub",
    "",
    "Private Sub Foo()",
    "    Bar()",
    "End Sub",
    ">>>>>>> REPLACE",
  );

  function setup(): { dir: string; changesPath: string } {
    const dir = setupProject();
    writeFileSync(join(dir, "Form1.vb"), FORM, "utf8");
    const changesPath = join(dir, "changes.md");
    writeFileSync(changesPath, APPEND_CHANGES, "utf8");
    return { dir, changesPath };
  }

  const form = (dir: string): string => readFileSync(join(dir, "Form1.vb"), "utf8");

  /** 実行中の stderr を捕まえる (メッセージ検証用) */
  async function captureErr(run: () => Promise<number>): Promise<{ code: number; text: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      return { code: await run(), text: chunks.join("") };
    } finally {
      spy.mockRestore();
    }
  }

  it("追記型ブロックの再実行は重複追記せず「済み」で正常終了する", async () => {
    const { dir, changesPath } = setup();
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(form(dir)).toBe(APPENDED);

    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(form(dir)).toBe(APPENDED);
    expect(historyIds(dir)).toHaveLength(1);
  });

  it("適用後に手修正していて書き込みが発生する再実行は、履歴の指紋で止める", async () => {
    const { dir, changesPath } = setup();
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    const edited = APPENDED.replace("Bar()", "Bar(1)");
    writeFileSync(join(dir, "Form1.vb"), edited, "utf8");

    // 前置き・改行コードが違っても同じ変更なら検出する (チャットから取り直した場合)
    const again = join(dir, "changes (1).md");
    writeFileSync(again, ("了解です。\n\n" + APPEND_CHANGES).replace(/\n/g, "\r\n"), "utf8");
    const { code, text } = await captureErr(() => applyCommand([again, "--root", dir, "--yes"]));
    expect(code).toBe(1);
    expect(text).toContain(`適用済みです (履歴 ID: ${historyIds(dir)[0]})`);
    expect(text).toContain("replace Form1.vb");
    expect(text).toContain("--force");
    expect(form(dir)).toBe(edited);
    expect(historyIds(dir)).toHaveLength(1);
  });

  it("--dry-run は警告のみで書き込まず exit 0、--force なら再適用する", async () => {
    const { dir, changesPath } = setup();
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    const edited = APPENDED.replace("Bar()", "Bar(1)");
    writeFileSync(join(dir, "Form1.vb"), edited, "utf8");

    expect(await applyCommand([changesPath, "--root", dir, "--yes", "--dry-run"])).toBe(0);
    expect(form(dir)).toBe(edited);

    expect(await applyCommand([changesPath, "--root", dir, "--yes", "--force"])).toBe(0);
    expect(form(dir)).not.toBe(edited);
    expect(historyIds(dir)).toHaveLength(2);
  });

  it("petari undo で巻き戻した changes.md は --force なしで再適用できる", async () => {
    const { dir, changesPath } = setup();
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(await undoCommand(["--root", dir, "--yes"])).toBe(0);
    expect(form(dir)).toBe(FORM);
    const [first] = historyIds(dir);
    const manifest = JSON.parse(
      readFileSync(join(dir, ".petari", "history", first as string, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(typeof manifest.undoneAt).toBe("string");

    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(form(dir)).toBe(APPENDED);
    expect(historyIds(dir)).toHaveLength(2);
  });

  it("指紋を持たない旧形式の履歴も、保存済みの changes.md 原本から検出する", async () => {
    const { dir, changesPath } = setup();
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    const [id] = historyIds(dir);
    const manifestPath = join(dir, ".petari", "history", id as string, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(typeof manifest.changesFingerprint).toBe("string");
    delete manifest.changesFingerprint;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    writeFileSync(join(dir, "Form1.vb"), APPENDED.replace("Bar()", "Bar(1)"), "utf8");
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(1);
    expect(historyIds(dir)).toHaveLength(1);
  });

  it("壊れた manifest は検出の対象外として無視する (適用は妨げない)", async () => {
    const { dir, changesPath } = setup();
    const broken = join(dir, ".petari", "history", "2000-01-01_0000");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "manifest.json"), "{ not json", "utf8");
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(0);
    expect(form(dir)).toBe(APPENDED);
  });
});
