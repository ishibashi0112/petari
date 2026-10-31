import { describe, expect, it } from "vitest";
import { planChangeSet, type FileState, type NewFileConfig } from "../src/core/applier.ts";
import {
  maskCredentials,
  maskLinesForDisplay,
  maskedViews,
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

describe("maskLinesForDisplay: 抜粋用の伏せた表示", () => {
  it("行数と位置を保ったまま値を伏せる", () => {
    const lines = DB_VB.split("\n");
    const shown = maskLinesForDisplay(lines, { path: "Db.vb" });
    expect(shown).toHaveLength(lines.length);
    expect(shown[2]).toBe('        Dim pwd As String = "[MASKED]"');
    expect(shown[3]).toBe(lines[3]);
  });

  it("複数行の秘密鍵があっても、行継続の代入の値を伏せる (行ごとに伏せると漏れる)", () => {
    const lines = [
      "Module Keys",
      '    Const PEM As String = "-----BEGIN RSA PRIVATE KEY-----" & vbCrLf &',
      '        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun" & vbCrLf &',
      '        "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK" & vbCrLf &',
      '        "-----END RSA PRIVATE KEY-----"',
      "        Dim dbPassword As String = _",
      '            "Hunter2Secret"',
      "End Module",
    ];
    const shown = maskLinesForDisplay(lines, { path: "Keys.vb" });
    expect(shown).toHaveLength(lines.length);
    const joined = shown.join("\n");
    expect(joined).not.toContain("Hunter2Secret");
    expect(joined).not.toContain("MIIEowIBAAKCAQEA");
    expect(shown[5]).toBe(lines[5]);
    expect(shown[7]).toBe("End Module");
  });

  it("複数行にまたがる属性値を伏せる", () => {
    const lines = ["<configuration>", '  <add key="Mail" password="Hunter2', '     Secret" />', "</configuration>"];
    const shown = maskLinesForDisplay(lines, { path: "app.config" });
    expect(shown.join("\n")).not.toContain("Hunter2");
    expect(shown.join("\n")).not.toContain("Secret\"");
    expect(shown[3]).toBe("</configuration>");
  });

  it("1 行に収まった秘密鍵で行が増えても、後ろの行の位置がずれない", () => {
    const lines = [
      "service:",
      '  key_inline: "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n"',
      '  conn: "Server=db1;Password=Hunter2Secret"',
      "  timeout: 30",
    ];
    const shown = maskLinesForDisplay(lines, { path: "service.yaml" });
    expect(shown).toHaveLength(4);
    expect(shown[1]).not.toContain("MIIEvQ");
    expect(shown[2]).toBe('  conn: "Server=db1;Password=[MASKED]"');
    expect(shown[3]).toBe("  timeout: 30");
  });

  it("END のない BEGIN の行で、後ろを全部伏せない", () => {
    const lines = ['Return s.StartsWith("-----BEGIN RSA PRIVATE KEY-----")', "Dim x = 1", "End Function"];
    expect(maskLinesForDisplay(lines, { path: "Pem.vb" })).toEqual(lines);
  });

  it(".vb は汎用テキストとしての伏せ方でも伏せる (generic 構成の追加ディレクトリ)", () => {
    const lines = ["Module M", "    Private Const pass = 48291375", "End Module"];
    const generic = maskCredentials(lines.join("\n"), { vbSource: false }).content;
    expect(generic).not.toContain("48291375");
    expect(maskLinesForDisplay(lines, { path: "M.vb" }).join("\n")).not.toContain("48291375");
  });

  it("伏せる処理と同じ範囲を伏せる (マスクのテストの入力すべてで、表示を結合すると一致)", () => {
    const inputs: [string, string][] = [
      ["a.config", '<add key="db" value="Server=s;User ID=sa;Password=p@ss;" />'],
      ["a.config", '<add password="Hunter2Secret" user="admin" />'],
      ["a.vb", 'Dim conn = "Data Source=x;Password=abc;"'],
      ["a.vb", "' pwd = \"secret123\""],
      ["a.vb", 'Login("user", "Hunter2Secret")'],
      ["a.txt", "AKIAIOSFODNN7EXAMPLE ghp_0123456789abcdefghijABCDEFGHIJ012345"],
      ["a.txt", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"],
    ];
    for (const [path, line] of inputs) {
      const expected = maskCredentials(line, { vbSource: path.endsWith(".vb") }).content;
      const views = maskedViews([line], path);
      expect(views.some((v) => v[0]?.text === expected)).toBe(true);
    }
  });
});

describe("restoreMaskedLines", () => {
  const original = ['pwd = "s3cret"', "Open(pwd)", 'conn = "Server=a;Password=p1"'];
  const views = maskedViews(original, "a.vb");

  it("同じ文字列の伏せた行から値を戻す (インデントは書き込む側のまま)", () => {
    const r = restoreMaskedLines(['    pwd = "[MASKED]"', "Log()"], views, { from: 0, to: 3 });
    expect(r).toEqual({ ok: true, lines: ['    pwd = "s3cret"', "Log()"], restored: 1 });
  });

  it("書き換えた行は戻さない (値の取り違えを避ける)", () => {
    const r = restoreMaskedLines(['conn = "Server=b;Password=[MASKED]"'], views, { from: 0, to: 3 });
    expect(r).toEqual({ ok: false, line: 'conn = "Server=b;Password=[MASKED]"', reason: "no-source" });
  });

  it("範囲の外の行からは戻さない", () => {
    const r = restoreMaskedLines(['pwd = "[MASKED]"'], views, { from: 1, to: 3 });
    expect(r.ok).toBe(false);
  });

  it("同じ表示で値の違う行が範囲に 2 つあれば戻さない", () => {
    const two = ['pwd = "aaa111"', 'pwd = "bbb222"'];
    const r = restoreMaskedLines(['pwd = "[MASKED]"'], maskedViews(two, "a.vb"), { from: 0, to: 2 });
    expect(r).toEqual({ ok: false, line: 'pwd = "[MASKED]"', reason: "ambiguous" });
  });

  it("literal なら戻せない [MASKED] をそのまま残す", () => {
    const r = restoreMaskedLines(['Log("[MASKED]")'], views, { from: 0, to: 3 }, { literal: true });
    expect(r).toEqual({ ok: true, lines: ['Log("[MASKED]")'], restored: 0 });
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

  it("実ファイルにもともとある [MASKED] の行は、残せばその文字のまま書く", () => {
    const source = 'const MASK = "[MASKED]";\nexport { MASK };\n';
    const plan = planChangeSet(
      cs(
        replace(
          "mask.ts",
          block(['const MASK = "[MASKED]";', "export { MASK };"], ['const MASK = "[MASKED]";', "export { MASK, other };"]),
        ),
      ),
      new Map([["mask.ts", state(source)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(text(plan.outcomes[0]?.afterBytes ?? null)).toBe('const MASK = "[MASKED]";\nexport { MASK, other };\n');
    expect(buildMaskRestoreNote(plan.outcomes, true)).toBeNull();
  });

  it("[MASKED] という文字を新しく書く行は、--literal-masked のときだけ書く", () => {
    const source = 'const MASK = "[MASKED]";\n';
    const change = cs(
      replace(
        "mask.ts",
        block(['const MASK = "[MASKED]";'], ['const MASK = "[MASKED]";', 'const LABEL = "[MASKED] は伏せ字";']),
      ),
    );
    const states = new Map([["mask.ts", state(source)]]);
    const plain = planChangeSet(change, states, NEW_FILE);
    expect(plain.ok).toBe(false);
    expect(plain.failures[0]?.kind).toBe("masked-value");
    const literal = planChangeSet(change, states, NEW_FILE, { literalMasked: true });
    expect(literal.ok).toBe(true);
    expect(text(literal.outcomes[0]?.afterBytes ?? null)).toContain('const LABEL = "[MASKED] は伏せ字";');
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

  it("create の伏せ字は戻す元がないので止める (--literal-masked なら書く)", () => {
    const change = cs({ op: "create", path: "New.vb", line: 1, content: ['Const Pwd = "[MASKED]"'] });
    const plan = planChangeSet(change, new Map(), NEW_FILE);
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
    expect(planChangeSet(change, new Map(), NEW_FILE, { literalMasked: true }).ok).toBe(true);
  });
});

/** slnmix のパックが AI に見せる行 (VB の伏せ方) */
const pack = (src: string, vbSource = true): string[] => maskCredentials(src, { vbSource }).content.split("\n");

describe("applier: 伏せ字で値を取り違えない・ファイルを壊さない", () => {
  const run = (path: string, src: string, b: ReplaceBlock) =>
    planChangeSet(cs(replace(path, b)), new Map([[path, state(src)]]), NEW_FILE);

  it("接続文字列のキーの順を入れ替えた行は書かずに止める (値が入れ替わるため)", () => {
    const src = 'Const CONN = "Server=db1;User ID=sa_admin;Password=Hunter2Secret"\n';
    const plan = run(
      "Db.vb",
      src,
      block(
        ['Const CONN = "Server=db1;User ID=[MASKED];Password=[MASKED]"'],
        ['Const CONN = "Server=db1;Password=[MASKED];User ID=[MASKED]"'],
      ),
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
  });

  it("伏せ字の行を残して新しい伏せ字の行を足すと、別の値を入れずに止める", () => {
    const src = 'Sub Init()\n    Dim userId As String = "sa_admin"\nEnd Sub\n';
    const plan = run(
      "Db.vb",
      src,
      block(
        ['    Dim userId As String = "[MASKED]"'],
        ['    Dim userId As String = "[MASKED]"', '    Dim password As String = "[MASKED]"'],
      ),
    );
    expect(plan.ok).toBe(false);
    expect(plan.outcomes[0]?.afterBytes).toBeNull();
  });

  it("コメントに [MASKED] と書いた行に値を書き出さない", () => {
    const src = 'Sub Init()\n    Dim pwd As String = "Hunter2Secret"\nEnd Sub\n';
    const plan = run(
      "Db.vb",
      src,
      block(
        ['    Dim pwd As String = "[MASKED]"'],
        ["    ' TODO: [MASKED] を設定ファイルへ移す", '    Dim pwd As String = GetSetting("pwd")'],
      ),
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
  });

  it("引数の順を入れ替えた行は書かずに止める", () => {
    const src = 'Sub Init()\n    Login("sa_admin", "Hunter2Secret")\nEnd Sub\n';
    const plan = run(
      "Db.vb",
      src,
      block(['    Login("[MASKED]", "[MASKED]")'], ['    LoginEx(password:="[MASKED]", user:="[MASKED]")']),
    );
    expect(plan.ok).toBe(false);
  });

  it("秘密鍵の定数の後ろに足す変更は、BEGIN / END の行を壊さない (一致させずに止める)", () => {
    const src = [
      "Module Keys",
      '    Const PEM As String = "-----BEGIN RSA PRIVATE KEY-----" & vbCrLf &',
      '        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun" & vbCrLf &',
      '        "-----END RSA PRIVATE KEY-----"',
      "End Module",
      "",
    ].join("\n");
    const p = pack(src);
    const plan = run(
      "Keys.vb",
      src,
      block([...p.slice(1, 4), "End Module"], [...p.slice(1, 4), "    ' rotated 2026-10", "End Module"]),
    );
    expect(plan.ok).toBe(false);
    expect(plan.outcomes[0]?.afterBytes).toBeNull();
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("YAML の秘密鍵の後ろに足す変更で、END 行のインデントを消さない", () => {
    const src = [
      "tls:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    -----END RSA PRIVATE KEY-----",
      "  port: 443",
      "",
    ].join("\n");
    const p = pack(src, false);
    const plan = run("tls.yaml", src, block(p.slice(2, 6), [...p.slice(2, 6), "  ciphers: modern"]));
    expect(plan.outcomes[0]?.afterBytes ?? null).toBeNull();
  });

  it("1 行の秘密鍵と複数行の秘密鍵が同じファイルにあっても、別の行を消さない", () => {
    const src = [
      "service:",
      '  key_inline: "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n"',
      '  conn: "Server=db1;Password=Hunter2Secret"',
      "  timeout: 30",
      "  retries: 3",
      "tls:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
      "    kgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+",
      "    -----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");
    const plan = run(
      "service.yaml",
      src,
      block(['  conn: "Server=db1;Password=[MASKED]"', "  timeout: 30"], ["  timeout: 30"]),
    );
    expect(plan.ok).toBe(true);
    const written = text(plan.outcomes[0]?.afterBytes ?? null);
    expect(written).toBe(src.replace('  conn: "Server=db1;Password=Hunter2Secret"\n', ""));
  });

  it("行継続の代入の値を、失敗レポートの抜粋に載せない", () => {
    const src = [
      "Module Keys",
      '    Const PEM As String = "-----BEGIN RSA PRIVATE KEY-----" & vbCrLf &',
      '        "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun" & vbCrLf &',
      '        "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK" & vbCrLf &',
      '        "-----END RSA PRIVATE KEY-----"',
      "    Sub Connect()",
      "        Dim dbPassword As String = _",
      '            "Hunter2Secret"',
      "        Open(dbPassword)",
      "    End Sub",
      "End Module",
      "",
    ].join("\n");
    const plan = run(
      "Keys.vb",
      src,
      block(
        ["        Dim dbPassword As String = _", '            "[MASKED]"', "        OpenDb(dbPassword)"],
        ["        Dim dbPassword As String = _", '            "[MASKED]"', "        OpenDb(dbPassword, 30)"],
      ),
    );
    const report = buildFailureReport(plan.failures, { outcomes: plan.outcomes });
    expect(report).toContain("実ファイルの該当箇所");
    expect(report).not.toContain("Hunter2Secret");
  });

  it("ファイルのどこかに [MASKED] という文字があっても、伏せた値の行は元の値に戻す", () => {
    const src = [
      "Module M",
      "    ' ログには値を [MASKED] として出す",
      '    Public Const DbPassword As String = "Hunter2Secret"',
      "End Module",
      "",
    ].join("\n");
    const content = pack(src).slice(0, -1);
    content.splice(3, 0, "    Public Const Timeout As Integer = 30");
    const plan = planChangeSet(
      cs({ op: "rewrite", path: "M.vb", line: 1, content }),
      new Map([["M.vb", state(src)]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    const written = text(plan.outcomes[0]?.afterBytes ?? null);
    expect(written).toContain('DbPassword As String = "Hunter2Secret"');
    expect(written).toContain("ログには値を [MASKED] として出す");
  });

  it("別の値の箇所を、伏せると同じに見えるだけで「適用済み」としない", () => {
    const src = [
      "Sub Prod()",
      '    Dim pwd As String = "ProdSecret1"',
      "End Sub",
      "Sub Test()",
      '    Dim pwd As String = "TestSecret2"',
      "End Sub",
      "",
    ].join("\n");
    const plan = run(
      "Db.vb",
      src,
      block(['    Dim pwd As String = "[MASKED]"', "    Log()"], ['    Dim pwd As String = "[MASKED]"']),
    );
    expect(plan.ok).toBe(false);
    expect(plan.outcomes[0]?.alreadyAppliedBlocks ?? []).toHaveLength(0);
  });

  it("伏せる前の行と同じ行の伏せ字は、インデントが変わっても元の値に戻す (trim-all)", () => {
    const plan = run(
      "Db.vb",
      DB_VB,
      block(
        ['Dim pwd As String = "[MASKED]"', "Open(pwd)"],
        ['Dim pwd As String = "[MASKED]"', "Open(pwd, 30)"],
      ),
    );
    expect(plan.ok).toBe(true);
    expect(text(plan.outcomes[0]?.afterBytes ?? null)).toContain(
      '        Dim pwd As String = "Hunter2Secret"\n        Open(pwd, 30)',
    );
  });

  it("Shift_JIS・CRLF のファイルでも、変えていない行のバイト列を保つ", () => {
    const sjis = (s: string): Uint8Array => {
      const out: number[] = [];
      for (const ch of s) {
        if (ch === "接") out.push(0x90, 0xda);
        else if (ch === "続") out.push(0x91, 0xb1);
        else out.push(ch.charCodeAt(0));
      }
      return new Uint8Array(out);
    };
    const src = ["' 接続", 'Dim pwd As String = "Hunter2Secret"', "Open(pwd)", ""].join("\r\n");
    const bytes = sjis(src);
    const plan = planChangeSet(
      cs(replace("Db.vb", block(['Dim pwd As String = "[MASKED]"', "Open(pwd)"], ['Dim pwd As String = "[MASKED]"', "Open(pwd, 30)"]))),
      new Map([["Db.vb", { exists: true, symlink: false, bytes }]]),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    const after = plan.outcomes[0]?.afterBytes ?? new Uint8Array();
    expect([...after.slice(0, 8)]).toEqual([...bytes.slice(0, 8)]);
    expect(new TextDecoder("shift_jis").decode(after)).toBe(
      ["' 接続", 'Dim pwd As String = "Hunter2Secret"', "Open(pwd, 30)", ""].join("\r\n"),
    );
  });
});
