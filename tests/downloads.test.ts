import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import {
  expandWindowsEnv,
  findRecentChangesFiles,
  parseRegQueryValue,
} from "../src/infra/downloads.ts";

const doc = (...lines: string[]): string => lines.join("\n");

describe("parseRegQueryValue / expandWindowsEnv (§10 Windows Known Folder)", () => {
  const GUID = "{374DE290-123F-4565-9164-39C4925E467B}";
  const REG_OUTPUT = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
    "    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads",
    "",
  ].join("\r\n");

  it("reg query の出力から値を取り出す", () => {
    expect(parseRegQueryValue(REG_OUTPUT, GUID)).toBe("%USERPROFILE%\\Downloads");
  });

  it("OneDrive リダイレクトされた REG_SZ 値も取り出せる", () => {
    const redirected = "    {374DE290-123F-4565-9164-39C4925E467B}    REG_SZ    D:\\OneDrive - Corp\\Downloads";
    expect(parseRegQueryValue(redirected, GUID)).toBe("D:\\OneDrive - Corp\\Downloads");
  });

  it("GUID がなければ null", () => {
    expect(parseRegQueryValue("nothing here", GUID)).toBeNull();
  });

  it("環境変数参照を展開する", () => {
    process.env["PETARI_TEST_VAR"] = "/home/x";
    expect(expandWindowsEnv("%PETARI_TEST_VAR%\\Downloads")).toBe("/home/x\\Downloads");
    expect(expandWindowsEnv("%UNDEFINED_XYZ%\\D")).toBe("%UNDEFINED_XYZ%\\D");
  });
});

describe("findRecentChangesFiles (§4.1 30 分ルール)", () => {
  it("changes*.md のみを対象に、30 分以内・新しい順で返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "petari-dl-"));
    const now = Date.now();
    const touch = (name: string, ageMinutes: number): void => {
      const p = join(dir, name);
      writeFileSync(p, "x");
      const t = new Date(now - ageMinutes * 60_000);
      utimesSync(p, t, t);
    };
    touch("changes.md", 10);
    touch("changes(1).md", 5);
    touch("CHANGES-final.md", 20);
    touch("changes-old.md", 45); // 30 分超 → 除外
    touch("other.md", 1); // パターン不一致 → 除外
    touch("changes.txt", 1); // 拡張子違い → 除外

    const found = findRecentChangesFiles(dir, new Date(now));
    expect(found.map((f) => f.path)).toEqual([
      join(dir, "changes(1).md"),
      join(dir, "changes.md"),
      join(dir, "CHANGES-final.md"),
    ]);
  });

  it("ディレクトリがなければ空配列", () => {
    expect(findRecentChangesFiles("/no/such/dir/petari", new Date())).toEqual([]);
  });
});

describe("applyCommand: Downloads 自動検出 (§4.1)", () => {
  it("引数なしで最新の changes.md を適用し、成功後に Downloads から移動する", async () => {
    const project = mkdtempSync(join(tmpdir(), "petari-dlp-"));
    const downloads = join(project, "fake-downloads");
    mkdirSync(downloads);
    writeFileSync(join(project, "a.txt"), "hello\n");
    mkdirSync(join(project, ".petari"));
    writeFileSync(
      join(project, ".petari", "config.json"),
      JSON.stringify({ downloadsDir: downloads }),
      "utf8",
    );
    const changesPath = join(downloads, "changes.md");
    writeFileSync(
      changesPath,
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.txt (replace)",
        "<<<<<<< SEARCH",
        "hello",
        "=======",
        "goodbye",
        ">>>>>>> REPLACE",
      ),
      "utf8",
    );

    const code = await applyCommand(["--root", project, "--yes"]);
    expect(code).toBe(0);
    // 適用され、Downloads の changes.md は移動 (削除) される
    expect(existsSync(changesPath)).toBe(false);
    const history = join(project, ".petari", "history");
    expect(existsSync(history)).toBe(true);
  });

  it("候補がなければエラー", async () => {
    const project = mkdtempSync(join(tmpdir(), "petari-dle-"));
    const downloads = join(project, "fake-downloads");
    mkdirSync(downloads);
    mkdirSync(join(project, ".petari"));
    writeFileSync(
      join(project, ".petari", "config.json"),
      JSON.stringify({ downloadsDir: downloads }),
      "utf8",
    );
    expect(await applyCommand(["--root", project, "--yes"])).toBe(1);
  });
});
