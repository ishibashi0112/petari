import { describe, expect, it } from "vitest";
import { planChangeSet, type FileState, type NewFileConfig } from "../src/core/applier.ts";
import {
  extractMaskedValues,
  maskedLines,
  restoreMaskedLines,
} from "../src/core/mask.ts";
import { buildFailureReport, buildMaskRestoreNote } from "../src/core/report.ts";
import type { ChangeSet, FileChange, ReplaceBlock } from "../src/types.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array());
const NEW_FILE: NewFileConfig = { encoding: "utf8", eol: "lf" };

const block = (search: string[], replace: string[], index = 1): ReplaceBlock => ({
  search,
  replace,
  line: 1,
  index,
});
const cs = (...files: FileChange[]): ChangeSet => ({ header: "概要", files });
const state = (s: string): FileState => ({ exists: true, symlink: false, bytes: utf8(s) });
const replace = (path: string, ...blocks: ReplaceBlock[]): FileChange => ({
  op: "replace",
  path,
  line: 1,
  blocks,
});

const DB_VB = [
  "Module Db",
  "    Sub Connect()",
  '        Dim pwd As String = "Hunter2Secret"',
  "        Open(pwd)",
  "    End Sub",
  "End Module",
  "",
].join("\n");

describe("maskedLines: 伏せた表示", () => {
  it("行数と位置を保ったまま値を伏せる", () => {
    const lines = DB_VB.split("\n");
    const masked = maskedLines(lines, true);
    expect(masked).toHaveLength(lines.length);
    expect(masked[2]).toBe('        Dim pwd As String = "[MASKED]"');
    expect(masked[3]).toBe(lines[3]);
  });

  it("秘密鍵のブロックで行数が変わるときは行ごとに伏せる", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const lines = ["-----BEGIN PRIVATE KEY-----", body, body, "-----END PRIVATE KEY-----"];
    const masked = maskedLines(lines, false);
    expect(masked).toHaveLength(4);
    expect(masked[0]).toBe(lines[0]);
    expect(masked.join("\n")).not.toContain(body);
  });
});

describe("extractMaskedValues", () => {
  it("伏せた値を順に取り出す", () => {
    expect(
      extractMaskedValues(
        "Server=db1;User ID=[MASKED];Password=[MASKED];",
        "Server=db1;User ID=sa;Password=p@ss;",
      ),
    ).toEqual(["sa", "p@ss"]);
  });

  it("行末の伏せ字も取り出す", () => {
    expect(extractMaskedValues("PWD=[MASKED]", "PWD=abc")).toEqual(["abc"]);
  });

  it("元の行と食い違えば null", () => {
    expect(extractMaskedValues('x = "[MASKED]"', 'y = "abc"')).toBeNull();
  });

  it("伏せ字が隣り合うと境目が決まらないので null", () => {
    expect(extractMaskedValues("[MASKED][MASKED]", "abcdef")).toBeNull();
  });
});

describe("restoreMaskedLines", () => {
  const original = ['pwd = "s3cret"', "Open(pwd)", 'conn = "Server=a;Password=p1"'];
  const masked = ['pwd = "[MASKED]"', "Open(pwd)", 'conn = "Server=a;Password=[MASKED]"'];
  const all = { from: 0, to: 3, similar: true };

  it("同じ文字列の伏せた行から値を戻す (インデントは書き込む側のまま)", () => {
    const r = restoreMaskedLines(['    pwd = "[MASKED]"', "Log()"], masked, original, all);
    expect(r).toEqual({ ok: true, lines: ['    pwd = "s3cret"', "Log()"], restored: 1 });
  });

  it("書き換えた行でも、伏せ字の数が同じ行が 1 つに決まれば値を戻す", () => {
    const r = restoreMaskedLines(
      ['conn = "Server=b;Password=[MASKED]"'],
      masked,
      original,
      { from: 2, to: 3, similar: true },
    );
    expect(r).toEqual({ ok: true, lines: ['conn = "Server=b;Password=p1"'], restored: 1 });
  });

  it("候補が 2 つあって値が違えば戻さない", () => {
    const r = restoreMaskedLines(['other = "[MASKED]"'], masked, original, all);
    expect(r).toEqual({ ok: false, line: 'other = "[MASKED]"', reason: "ambiguous" });
  });

  it("範囲に伏せた行がなければ戻さない", () => {
    const r = restoreMaskedLines(['pwd = "[MASKED]"'], masked, original, {
      from: 1,
      to: 2,
      similar: true,
    });
    expect(r).toEqual({ ok: false, line: 'pwd = "[MASKED]"', reason: "no-source" });
  });

  it("similar でなければ同じ文字列の行しか使わない", () => {
    const r = restoreMaskedLines(['conn = "Server=b;Password=[MASKED]"'], masked, original, {
      from: 0,
      to: 3,
      similar: false,
    });
    expect(r.ok).toBe(false);
  });
});

describe("applier: 伏せ字の行の照合と復元", () => {
  it("SEARCH の [MASKED] を伏せた表示と照合し、書き込みでは元の値に戻す", () => {
    const plan = planChangeSet(
      cs(
        replace(
          "Db.vb",
          block(
            ['        Dim pwd As String = "[MASKED]"', "        Open(pwd)"],
            ['        Dim pwd As String = "[MASKED]"', '        Log("connect")', "        Open(pwd)"],
          ),
        ),
      ),
      new Map([["Db.vb", state(DB_VB)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    const written = text(plan.outcomes[0]?.afterBytes ?? null);
    expect(written).toContain('Dim pwd As String = "Hunter2Secret"');
    expect(written).toContain('Log("connect")');
    expect(written).not.toContain("[MASKED]");
    expect(plan.outcomes[0]?.appliedBlocks[0]?.restoredMasks).toBe(1);
    expect(buildMaskRestoreNote(plan.outcomes, true)).toContain("1 箇所");
  });

  it("失敗レポートの抜粋には実際の値を載せない", () => {
    const plan = planChangeSet(
      cs(
        replace(
          "Db.vb",
          block(
            ['        Dim pwd As String = "[MASKED]"', "        OpenDb(pwd)"],
            ['        Dim pwd As String = "[MASKED]"', "        OpenDb(pwd, 30)"],
          ),
        ),
      ),
      new Map([["Db.vb", state(DB_VB)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).not.toContain("Hunter2Secret");
    expect(report).toContain('Dim pwd As String = "[MASKED]"');
  });

  it("SEARCH に伏せ字がなくても、抜粋の前後の行は伏せる", () => {
    const plan = planChangeSet(
      cs(replace("Db.vb", block(["        Open(pwd)", "    End Sub", "End Modul"], ["x"]))),
      new Map([["Db.vb", state(DB_VB)]]),
      NEW_FILE,
    );
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("実ファイルの該当箇所");
    expect(report).not.toContain("Hunter2Secret");
  });

  it("元の値のない伏せ字を足す REPLACE は書かずに止める", () => {
    const plan = planChangeSet(
      cs(
        replace(
          "Db.vb",
          block(["        Open(pwd)"], ['        Dim key As String = "[MASKED]"', "        Open(pwd)"]),
        ),
      ),
      new Map([["Db.vb", state(DB_VB)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
    expect(plan.outcomes[0]?.afterBytes).toBeNull();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("NG 伏せ字を元の値に戻せない");
  });

  it("適用済みの判定も伏せた表示で行う (再実行で止まらない)", () => {
    const applied = DB_VB.replace("        Open(pwd)", '        Log("connect")\n        Open(pwd)');
    const plan = planChangeSet(
      cs(
        replace(
          "Db.vb",
          block(
            ['        Dim pwd As String = "[MASKED]"', "        Open(pwd)"],
            ['        Dim pwd As String = "[MASKED]"', '        Log("connect")', "        Open(pwd)"],
          ),
        ),
      ),
      new Map([["Db.vb", state(applied)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.alreadyApplied).toBe(true);
  });

  it("実ファイルにもともと [MASKED] という文字があれば、そのまま書く", () => {
    const source = 'const MASK = "[MASKED]";\nexport { MASK };\n';
    const plan = planChangeSet(
      cs(
        replace(
          "mask.ts",
          block(['const MASK = "[MASKED]";'], ['const MASK = "[MASKED]";', 'const LABEL = "[MASKED] は伏せ字";']),
        ),
      ),
      new Map([["mask.ts", state(source)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(text(plan.outcomes[0]?.afterBytes ?? null)).toContain('const LABEL = "[MASKED] は伏せ字";');
  });

  it("rewrite は同じ文字列の伏せた行から値を戻す", () => {
    const content = DB_VB.replace("        Open(pwd)", '        Log("connect")\n        Open(pwd)')
      .replace("Hunter2Secret", "[MASKED]")
      .split("\n")
      .slice(0, -1);
    const plan = planChangeSet(
      cs({ op: "rewrite", path: "Db.vb", line: 1, content }),
      new Map([["Db.vb", state(DB_VB)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    const written = text(plan.outcomes[0]?.afterBytes ?? null);
    expect(written).toContain('"Hunter2Secret"');
    expect(written).not.toContain("[MASKED]");
    expect(buildMaskRestoreNote(plan.outcomes, false)).toContain("1 箇所");
  });

  it("rewrite で伏せ字の行を書き換えていたら止める", () => {
    const content = DB_VB.replace(
      'Dim pwd As String = "Hunter2Secret"',
      'Dim password As String = "[MASKED]"',
    ).split("\n");
    const plan = planChangeSet(
      cs({ op: "rewrite", path: "Db.vb", line: 1, content }),
      new Map([["Db.vb", state(DB_VB)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
  });

  it("create の伏せ字は戻す元がないので止める", () => {
    const plan = planChangeSet(
      cs({ op: "create", path: "New.vb", line: 1, content: ['Const Pwd = "[MASKED]"'] }),
      new Map(),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
  });
});
