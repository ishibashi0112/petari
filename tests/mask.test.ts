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
    expect(r).toEqual({
      ok: true,
      lines: ['    pwd = "s3cret"', "Log()"],
      restored: 1,
      literal: 0,
      sources: [0, null],
    });
  });

  it("書き換えた行は戻さない (値の取り違えを避ける)", () => {
    const r = restoreMaskedLines(['conn = "Server=b;Password=[MASKED]"'], views, { from: 0, to: 3 });
    expect(r).toEqual({
      ok: false,
      failures: [{ line: 'conn = "Server=b;Password=[MASKED]"', reason: "no-source" }],
      literalRefused: false,
      literalAllowed: false,
    });
  });

  it("戻せない行はすべて報告する", () => {
    const r = restoreMaskedLines(
      ['conn = "Server=b;Password=[MASKED]"', 'pwd = "[MASKED]"', 'Log("[MASKED]")'],
      views,
      { from: 0, to: 3 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failures.map((f) => f.line)).toEqual(['conn = "Server=b;Password=[MASKED]"', 'Log("[MASKED]")']);
  });

  it("範囲の外の行からは戻さない", () => {
    const r = restoreMaskedLines(['pwd = "[MASKED]"'], views, { from: 1, to: 3 });
    expect(r.ok).toBe(false);
  });

  it("同じ表示で値の違う行が範囲に 2 つあれば戻さない", () => {
    const two = ['pwd = "aaa111"', 'pwd = "bbb222"'];
    const r = restoreMaskedLines(['pwd = "[MASKED]"'], maskedViews(two, "a.vb"), { from: 0, to: 2 });
    expect(r).toEqual({
      ok: false,
      failures: [{ line: 'pwd = "[MASKED]"', reason: "ambiguous" }],
      literalRefused: false,
      literalAllowed: false,
    });
  });

  it("literal なら戻せない [MASKED] をそのまま残す (範囲に実際の値を伏せた行がないとき)", () => {
    const plain = maskedViews(["Open(pwd)", "Log()"], "a.vb");
    const before = restoreMaskedLines(['Log("[MASKED]")'], plain, { from: 0, to: 2 });
    expect(before).toMatchObject({ ok: false, literalRefused: false, literalAllowed: true });
    const r = restoreMaskedLines(['Log("[MASKED]")'], plain, { from: 0, to: 2 }, { literal: true });
    expect(r).toEqual({ ok: true, lines: ['Log("[MASKED]")'], restored: 0, literal: 1, sources: [null] });
  });

  it("literal でも範囲に実際の値を伏せた行があれば使わない (実際の値を [MASKED] で上書きしない)", () => {
    const r = restoreMaskedLines(['Log("[MASKED]")'], views, { from: 0, to: 3 }, { literal: true });
    expect(r).toEqual({
      ok: false,
      failures: [{ line: 'Log("[MASKED]")', reason: "no-source" }],
      literalRefused: true,
      literalAllowed: false,
    });
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

describe("applier: 設定ファイルの伏せた値", () => {
  const config = [
    "<configuration>",
    "  <appSettings>",
    '    <add key="DbPassword" value="Hunter2Secret" />',
    '    <add key="Theme" value="Dark" />',
    "  </appSettings>",
    "  <applicationSettings>",
    '    <setting name="ApiToken" serializeAs="String">',
    "      <value>Tok3nSecretValue</value>",
    "    </setting>",
    "  </applicationSettings>",
    "</configuration>",
    "",
  ].join("\n");
  const states = new Map([["App.config", state(config)]]);

  it("パックから写した appSettings / My.Settings の行を元の値に戻して書く", () => {
    const packed = maskCredentials(config, { vbSource: false, strict: true }).content.split("\n");
    expect(packed[2]).toBe('    <add key="DbPassword" value="[MASKED]" />');
    expect(packed[7]).toBe("      <value>[MASKED]</value>");
    const p = planChangeSet(
      cs(
        replace(
          "App.config",
          block(packed.slice(2, 4), [packed[2] as string, '    <add key="Theme" value="Light" />']),
          block(packed.slice(6, 9), [...packed.slice(6, 9), "    <!-- token -->"], 2),
        ),
      ),
      states,
      NEW_FILE,
    );
    expect(p.ok).toBe(true);
    expect(text(p.outcomes[0]?.afterBytes ?? null)).toBe(
      config.replace('value="Dark"', 'value="Light"').replace("    </setting>\n", "    </setting>\n    <!-- token -->\n"),
    );
  });

  it("失敗レポートの抜粋に appSettings / My.Settings の値を出さない", () => {
    const p = planChangeSet(
      cs(replace("App.config", block(['    <add key="Theme" value="Blue" />', "  </appSettings>"], ["x"]))),
      states,
      NEW_FILE,
    );
    const report = buildFailureReport(p.failures);
    expect(report).toContain('value="[MASKED]"');
    expect(report).not.toContain("Hunter2Secret");
    expect(report).not.toContain("Tok3nSecretValue");
  });
});

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

  it("実際の値の行と、[MASKED] という文字の行が伏せると同じに見えるなら、どちらとも決めずに止める", () => {
    const src = [
      "Module Tests",
      "    Sub Expected()",
      '        Dim conn As String = "Server=db1;Password=[MASKED]"',
      "        Check(conn)",
      "    End Sub",
      "    Sub Real()",
      '        Dim conn As String = "Server=db1;Password=Hunter2Secret"',
      "        Open(conn)",
      "    End Sub",
      "End Module",
      "",
    ].join("\n");
    const plan = run(
      "Tests.vb",
      src,
      block(
        ['        Dim conn As String = "Server=db1;Password=[MASKED]"'],
        ['        Dim conn As String = "Server=db1;Password=[MASKED]"', '        Log("opening")'],
      ),
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("block-ambiguous");
  });

  it("失敗レポートの抜粋 (伏せ方を合わせた表示) をそのまま写した SEARCH でも一致し、元の値に戻す", () => {
    const src = [
      "Public Class Login",
      "    Sub DoLogin()",
      '        Dim userName As String = "sa_admin"',
      "        pwd = txtPassword.Text",
      "        Connect(userName, pwd)",
      "    End Sub",
      "End Class",
      "",
    ].join("\n");
    // .vb の抜粋は VB / 汎用テキストの両方の伏せ方の範囲を伏せるため、pwd = の右辺も伏せて見える
    const first = run(
      "Login.vb",
      src,
      block(
        ['        Dim userName As String = "[MASKED]"', "        pwd = txtPassword.Text", "        Conect(userName, pwd)"],
        ['        Dim userName As String = "[MASKED]"', "        pwd = txtPassword.Text", "        Connect(userName, pwd, 30)"],
      ),
    );
    const report = buildFailureReport(first.failures);
    expect(report).toContain("│        pwd = [MASKED]");
    expect(report).not.toContain("sa_admin");
    const second = run(
      "Login.vb",
      src,
      block(
        ['        Dim userName As String = "[MASKED]"', "        pwd = [MASKED]", "        Connect(userName, pwd)"],
        ['        Dim userName As String = "[MASKED]"', "        pwd = [MASKED]", "        Connect(userName, pwd, 30)"],
      ),
    );
    expect(second.ok).toBe(true);
    expect(text(second.outcomes[0]?.afterBytes ?? null)).toContain(
      '        Dim userName As String = "sa_admin"\n        pwd = txtPassword.Text\n        Connect(userName, pwd, 30)',
    );
  });

  it("--literal-masked でも、範囲に実際の値を伏せた行があれば [MASKED] の文字で上書きしない", () => {
    const change = cs(
      replace(
        "Db.vb",
        block(['        Dim pwd As String = "[MASKED]"'], ['        Dim pwd As String = "[MASKED]" \' 本番', "        Log()"]),
      ),
    );
    const states = new Map([["Db.vb", state(DB_VB)]]);
    const plan = planChangeSet(change, states, NEW_FILE, { literalMasked: true });
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.kind).toBe("masked-value");
    expect(plan.failures[0]?.literalRefused).toBe(true);
    expect(plan.failures[0]?.literalAllowed).toBeUndefined();
    const plain = planChangeSet(change, states, NEW_FILE);
    expect(plain.failures[0]?.literalRefused).toBeUndefined();
    expect(plain.failures[0]?.literalAllowed).toBeUndefined();
  });

  it("元の値に戻せない行はすべて失敗の理由に載せる", () => {
    const plan = run(
      "Db.vb",
      DB_VB,
      block(
        ['        Dim pwd As String = "[MASKED]"', "        Open(pwd)"],
        ['        Dim pwd As String = "[MASKED]" \' 本番', '        Console.WriteLine("pwd=[MASKED]")', "        Open(pwd)"],
      ),
    );
    expect(plan.ok).toBe(false);
    const message = plan.failures[0]?.message ?? "";
    expect(message).toContain('Dim pwd As String = "[MASKED]" \' 本番');
    expect(message).toContain('Console.WriteLine("pwd=[MASKED]")');
    expect(message).not.toContain("Hunter2Secret");
  });
});

describe("applier: 先のブロックの変更のあとも、元のファイルで伏せた値は伏せたまま扱う", () => {
  const CONST_VB = [
    "Module Db",
    "    Private Const DB_PASSWORD As String = _",
    '        "Hunter2Pass"',
    "    Sub Connect()",
    "        Open(DB_PASSWORD)",
    "    End Sub",
    "End Module",
    "",
  ].join("\n");
  const plan = (src: string, ...blocks: ReplaceBlock[]) =>
    planChangeSet(cs(replace("Db.vb", ...blocks)), new Map([["Db.vb", state(src)]]), NEW_FILE);

  it("前の行を書き換えて伏せる条件が変わっても、次のブロックは伏せた表示で照合し、抜粋に値を載せない", () => {
    const p = plan(
      CONST_VB,
      block(["    Private Const DB_PASSWORD As String = _"], ["    Private ReadOnly DB_PASSWORD As String = Decrypt( _"], 1),
      block(['        "[MASKED]"', "    Sub Connect()"], ['        "[MASKED]")', "    Sub Connect()"], 2),
    );
    expect(p.ok).toBe(false);
    // 2 つ目は一致したうえで、伏せ字の行を書き換えているため止まる
    expect(p.failures.map((f) => f.kind)).toEqual(["masked-value"]);
    expect(buildFailureReport(p.failures, { outcomes: p.outcomes })).not.toContain("Hunter2Pass");
  });

  it("前の行を書き換えたあとの失敗したブロックの抜粋にも値を載せない", () => {
    const p = plan(
      CONST_VB,
      block(["    Private Const DB_PASSWORD As String = _"], ["    Private ReadOnly DB_PASSWORD As String = Decrypt( _"], 1),
      block(["    Sub Conect()"], ["    Sub Connect(timeout As Integer)"], 2),
    );
    expect(p.failures.map((f) => f.kind)).toEqual(["block-not-found"]);
    expect(buildFailureReport(p.failures, { outcomes: p.outcomes })).not.toContain("Hunter2Pass");
  });

  it("伏せ字の行を残して書いた行も、次のブロックでは伏せたまま扱う", () => {
    const p = plan(
      CONST_VB,
      block(
        ["    Private Const DB_PASSWORD As String = _", '        "[MASKED]"'],
        ["    Private Const DB_PW As String = _", '        "[MASKED]"'],
        1,
      ),
      block(["        Opn(DB_PASSWORD)"], ["        Open(DB_PW)"], 2),
    );
    expect(p.failures.map((f) => f.kind)).toEqual(["block-not-found"]);
    expect(buildFailureReport(p.failures, { outcomes: p.outcomes })).not.toContain("Hunter2Pass");
    const ok = plan(
      CONST_VB,
      block(
        ["    Private Const DB_PASSWORD As String = _", '        "[MASKED]"'],
        ["    Private Const DB_PW As String = _", '        "[MASKED]"'],
        1,
      ),
      block(['        "[MASKED]"', "    Sub Connect()", "        Open(DB_PASSWORD)"], ['        "[MASKED]"', "    Sub Connect()", "        Open(DB_PW)"], 2),
    );
    expect(ok.ok).toBe(true);
    expect(text(ok.outcomes[0]?.afterBytes ?? null)).toContain('    Private Const DB_PW As String = _\n        "Hunter2Pass"\n    Sub Connect()\n        Open(DB_PW)');
  });

  it("伏せると同じに見える別の値の箇所を、先のブロックの変更のあとでも「適用済み」としない", () => {
    const src = [
      "Module Db",
      "    Sub ConnectProd()",
      '        Dim pwd As String = "ProdPass1"',
      "        Open(pwd)",
      "    End Sub",
      "    Sub ConnectTest()",
      '        Dim pwd As String = "TestPass2"',
      "        Open(pwd)",
      "    End Sub",
      "End Module",
      "",
    ].join("\n");
    const p = plan(
      src,
      block(
        ["    Sub ConnectProd()", '        Dim pwd As String = "[MASKED]"', "        Open(pwd)"],
        ["    Sub ConnectProd()", '        Dim pwd As String = "[MASKED]"', "        Open(pwd, 30)"],
        1,
      ),
      block(
        ['        Dim pwd As String = "[MASKED]"', "        Open(pwd )", "    End Sub"],
        ['        Dim pwd As String = "[MASKED]"', "        Open(pwd, 30)", "    End Sub"],
        2,
      ),
    );
    expect(p.ok).toBe(false);
    expect(p.outcomes[0]?.alreadyAppliedBlocks).toEqual([]);
    expect(p.failures.map((f) => f.kind)).toEqual(["block-not-found"]);
  });
});

describe("applier: --literal-masked で実際の値を [MASKED] の文字に置き換えない", () => {
  const OLD = ["Module Db", '    Public Const DB_PASSWORD As String = "Hunter2Pass"', "End Module", ""].join("\n");

  it("ファイルの移動 (delete + create) で伏せ字の行を書くときは使わない", () => {
    const change = cs(
      { op: "delete", path: "Db.vb", line: 1 },
      { op: "create", path: "Data/Db.vb", line: 1, content: ["Module Db", '    Public Const DB_PASSWORD As String = "[MASKED]"', "End Module"] },
    );
    const states = new Map<string, FileState>([
      ["Db.vb", state(OLD)],
      ["Data/Db.vb", { exists: false, symlink: false, bytes: null }],
    ]);
    const p = planChangeSet(change, states, NEW_FILE, { literalMasked: true });
    expect(p.ok).toBe(false);
    expect(p.failures.map((f) => [f.kind, f.literalRefused, f.literalAllowed])).toEqual([["masked-value", true, undefined]]);
  });

  it("同じファイルの中で伏せ字の行を移すときも使わない", () => {
    const src = ["Module Db", '    Public Const DB_PASSWORD As String = "Hunter2Pass"', "    Sub A()", "    End Sub", "End Module", ""].join("\n");
    const p = planChangeSet(
      cs(
        replace(
          "Db.vb",
          block(["Module Db", '    Public Const DB_PASSWORD As String = "[MASKED]"', "    Sub A()"], ["Module Db", "    Sub A()"], 1),
          block(["    End Sub", "End Module"], ["    End Sub", '    Public Const DB_PASSWORD As String = "[MASKED]"', "End Module"], 2),
        ),
      ),
      new Map([["Db.vb", state(src)]]),
      NEW_FILE,
      { literalMasked: true },
    );
    expect(p.ok).toBe(false);
    expect(p.failures[0]?.literalRefused).toBe(true);
  });

  it("秘密鍵のファイルの移動 (複数行の値) でも使わない", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "KUPBAoGBAOp8tQi7aXOm1pcbHs2Oe7AcHqwKmk3yyp7wNnB0dD9uSaGaJYAGRx9e",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");
    const change = cs(
      { op: "delete", path: "certs/old.pem", line: 1 },
      {
        op: "create",
        path: "certs/new.pem",
        line: 1,
        content: ["-----BEGIN RSA PRIVATE KEY-----", "[MASKED]", "-----END RSA PRIVATE KEY-----"],
      },
    );
    const states = new Map<string, FileState>([
      ["certs/old.pem", state(pem)],
      ["certs/new.pem", { exists: false, symlink: false, bytes: null }],
    ]);
    const p = planChangeSet(change, states, NEW_FILE, { literalMasked: true });
    expect(p.ok).toBe(false);
    expect(p.failures[0]?.literalRefused).toBe(true);
  });

  it("先のブロックで書いた [MASKED] という文字の行を、次のブロックで残してもそのまま書く", () => {
    const src = ["Sub A()", "    x = 1", "End Sub", "Sub B()", '    Dim pwd As String = "Hunter2Secret"', "End Sub", ""].join("\n");
    const p = planChangeSet(
      cs(
        replace(
          "M.vb",
          block(["    x = 1"], ["    x = 1", '    msg = "[MASKED]"'], 1),
          block(['    msg = "[MASKED]"'], ['    msg = "[MASKED]"', "    y = 2"], 2),
        ),
      ),
      new Map([["M.vb", state(src)]]),
      NEW_FILE,
      { literalMasked: true },
    );
    expect(p.ok).toBe(true);
    const written = text(p.outcomes[0]?.afterBytes ?? null);
    expect(written).toContain('    x = 1\n    msg = "[MASKED]"\n    y = 2');
    expect(written).toContain('"Hunter2Secret"');
  });

  it("読めないファイル (UTF-16) を消す変更と一緒なら使わない", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[..."password=Hunter2\n"].flatMap((c) => [c.charCodeAt(0), 0])]);
    const change = cs(
      { op: "delete", path: "old.config", line: 1 },
      { op: "create", path: "new.config", line: 1, content: ["password=[MASKED]"] },
    );
    const states = new Map<string, FileState>([
      ["old.config", { exists: true, symlink: false, bytes: utf16 }],
      ["new.config", { exists: false, symlink: false, bytes: null }],
    ]);
    const p = planChangeSet(change, states, NEW_FILE, { literalMasked: true });
    expect(p.ok).toBe(false);
    expect(p.failures[0]?.literalRefused).toBe(true);
  });

  it("別のファイルで同じ値の行を増やしても、消えた値の埋め合わせにしない", () => {
    const line = '        Open("Data Source=db;Password=P@ss1")';
    const change = cs(
      replace("A.vb", block([line], [line, "        Log()", line])),
      replace("C.vb", block([line], [])),
      { op: "create", path: "D.vb", line: 1, content: ['        Open("Data Source=db;Password=[MASKED]")'] },
    );
    const states = new Map<string, FileState>([
      ["A.vb", state(`Module A\n${line}\nEnd Module\n`)],
      ["C.vb", state(`Module C\n${line}\nEnd Module\n`)],
      ["D.vb", { exists: false, symlink: false, bytes: null }],
    ]);
    const masked = cs(
      replace("A.vb", block(['        Open("Data Source=db;Password=[MASKED]")'], ['        Open("Data Source=db;Password=[MASKED]")', "        Log()", '        Open("Data Source=db;Password=[MASKED]")'])),
      replace("C.vb", block(['        Open("Data Source=db;Password=[MASKED]")'], [])),
      change.files[2] as FileChange,
    );
    const p = planChangeSet(masked, states, NEW_FILE, { literalMasked: true });
    expect(p.ok).toBe(false);
    expect(p.failures.map((f) => [f.path, f.literalRefused])).toEqual([["D.vb", true]]);
  });

  it("伏せた値が消えない変更なら、ほかのファイルに伏せ字があっても使う", () => {
    const change = cs(
      replace("Db.vb", block(["End Module"], ["    Sub A()", "    End Sub", "End Module"])),
      { op: "create", path: "Mask.vb", line: 1, content: ['Module Mask', '    Public Const TOKEN As String = "[MASKED]"', "End Module"] },
    );
    const states = new Map<string, FileState>([
      ["Db.vb", state(OLD)],
      ["Mask.vb", { exists: false, symlink: false, bytes: null }],
    ]);
    const p = planChangeSet(change, states, NEW_FILE, { literalMasked: true });
    expect(p.ok).toBe(true);
    expect(text(p.outcomes[1]?.afterBytes ?? null)).toContain('"[MASKED]"');
  });
});

describe("applier: 複数行の値・空行の差", () => {
  it("複数行にまたがる値を伏せた行を SEARCH に含めて失敗したら、その行を名指しする", () => {
    const src = ["<configuration>", '  <add key="Mail" password="Hunter2', '     Secret99" />', '  <add key="x" value="1" />', "</configuration>", ""].join("\n");
    const p = planChangeSet(
      cs(
        replace(
          "app.config",
          block(['  <add key="Mail" password="[MASKED]', '     [MASKED]" />', '  <add key="x" value="1" />'], ['  <add key="x" value="2" />']),
        ),
      ),
      new Map([["app.config", state(src)]]),
      NEW_FILE,
    );
    expect(p.failures[0]?.message).toContain("抜粋の 2〜3 行目は複数行にまたがる値");
    const report = buildFailureReport(p.failures);
    expect(report).not.toContain("Hunter2");
    expect(report).not.toContain("Secret99");
  });

  it("パックから写した字下げした秘密鍵の SEARCH には、抜粋を写すよう勧めず END の行も名指しする", () => {
    const src = [
      "service:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
      "    -----END RSA PRIVATE KEY-----",
      "  token: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
      "  port: 80",
      "",
    ].join("\n");
    // パックでは鍵の本文が 1 行の [MASKED] になり、END の行の字下げも伏せた範囲に入る
    const search = maskCredentials(src, { vbSource: false, strict: true }).content.split("\n").slice(1, 8);
    expect(search).toContain("-----END RSA PRIVATE KEY-----");
    const p = planChangeSet(
      cs(replace("svc.yaml", block(search, [...search, "  host: x"]))),
      new Map([["svc.yaml", state(src)]]),
      NEW_FILE,
    );
    expect(p.failures[0]?.message).toContain("抜粋の 4〜5 行目は複数行にまたがる値");
    // END の行は伏せ字を含まないが、伏せ字を含む行と同じ SEARCH には入れられない
    expect(p.failures[0]?.message).toContain("抜粋の 6 行目は複数行にまたがる値 (秘密鍵など) を伏せた範囲にかかる、[MASKED] を含まない行");
    const report = buildFailureReport(p.failures);
    expect(report).toContain("- 4〜5 行目: 複数行にまたがる値");
    expect(report).toContain("- 6 行目: [MASKED] を含む行と一緒に使えない行");
    expect(report).not.toContain("修正のヒント");
    expect(report).not.toContain("この行も含めてコピーしてください");
    expect(report).toContain("「複数行にまたがる値を伏せた範囲にかかる行」とした行は SEARCH に含めず");
    expect(report).not.toContain("MIIEow");
    expect(report).not.toContain("ghp_A1b2");
    // 名指しした行を含まない範囲なら一致する
    const ok = planChangeSet(
      cs(replace("svc.yaml", block(["  token: [MASKED]", "  port: 80"], ["  token: [MASKED]", "  port: 8080"]))),
      new Map([["svc.yaml", state(src)]]),
      NEW_FILE,
    );
    expect(ok.ok).toBe(true);
    expect(text(ok.outcomes[0]?.afterBytes ?? null)).toBe(src.replace("port: 80", "port: 8080"));
  });

  it("伏せ字のない SEARCH では、秘密鍵の範囲の行が抜粋にあっても修正のヒントを出す (文脈のその行は写さない)", () => {
    const src = [
      "service:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    -----END RSA PRIVATE KEY-----",
      "  host: example",
      "  timeout: 30",
      "  port: 80",
      "",
    ].join("\n");
    const states = new Map([["s.yaml", state(src)]]);
    for (const [search, named] of [
      // END の行は (文脈でも SEARCH に対応づけた行でも) 写しても伏せ字が入らないので名指ししない
      [["  host: example", "  port: 80"], "- 4 行目: 複数行にまたがる値"],
      [["    -----END RSA PRIVATE KEY-----", "  host: example", "  port: 80"], "- 4 行目: 複数行にまたがる値"],
    ] as const) {
      const p = planChangeSet(cs(replace("s.yaml", block([...search], ["x"]))), states, NEW_FILE);
      const report = buildFailureReport(p.failures);
      expect(report).toContain("修正のヒント");
      // 前後の文脈にある鍵の範囲の行は名指しし、写すのは記号の付いた行だけと明記する
      expect(report).toContain(named);
      expect(report).not.toContain("4〜5 行目");
      expect(report).toContain("記号のない前後の文脈の行は含めません");
      expect(report).not.toContain("MIIEow");
    }
    // ヒントどおりに写せば一致する
    const copy = ["    -----END RSA PRIVATE KEY-----", "  host: example", "  timeout: 30", "  port: 80"];
    expect(planChangeSet(cs(replace("s.yaml", block(copy, [...copy.slice(0, 3), "  port: 8080"]))), states, NEW_FILE).ok).toBe(true);
  });

  it("文脈の END の行は名指ししない (一意に特定するのに使える)", () => {
    const src = [
      "svc1:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    -----END RSA PRIVATE KEY-----",
      "  host: example",
      "  port: 80",
      "svc2:",
      "  host: example",
      "  port: 80",
      "",
    ].join("\n");
    const states = new Map([["s.yaml", state(src)]]);
    const p = planChangeSet(cs(replace("s.yaml", block(["  host: example", "  timeout: 5", "  port: 80"], ["x"]))), states, NEW_FILE);
    const report = buildFailureReport(p.failures);
    expect(report).toContain("- 4 行目: 複数行にまたがる値");
    expect(report).not.toContain("4〜5 行目");
    const anchored = ["    -----END RSA PRIVATE KEY-----", "  host: example", "  port: 80"];
    expect(planChangeSet(cs(replace("s.yaml", block(anchored, [...anchored.slice(0, 2), "  port: 8080"]))), states, NEW_FILE).ok).toBe(true);
  });

  it("前後の文脈にある鍵の本文の行も名指しする (その前の行で特定しようとして同じ失敗を繰り返さない)", () => {
    const src = [
      "service:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
      "    -----END RSA PRIVATE KEY-----",
      "  conn: Server=x;Password=Hunter2Secret;",
      "  host: example",
      "",
    ].join("\n");
    const p = planChangeSet(
      cs(replace("s.yaml", block(["-----END RSA PRIVATE KEY-----", "  conn: Server=x;Password=[MASKED];", "  host: wrong"], ["x"]))),
      new Map([["s.yaml", state(src)]]),
      NEW_FILE,
    );
    expect(p.failures[0]?.message).toContain("抜粋の 4〜5 行目は複数行にまたがる値");
    expect(p.failures[0]?.message).toContain("抜粋の 6 行目は複数行にまたがる値 (秘密鍵など) を伏せた範囲にかかる、[MASKED] を含まない行");
    const report = buildFailureReport(p.failures);
    expect(report).not.toContain("Hunter2Secret");
    expect(report).not.toContain("MIIEow");
  });

  it("文脈の END の行は、伏せ字の行と一緒に使えない行として注記する", () => {
    // 抜粋の文脈に伏せ字の行 (token) があると、END の行と一緒に写した SEARCH は伏せた表示で照合され一致しない
    const src = [
      "svc1:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    -----END RSA PRIVATE KEY-----",
      "  token: Xk3pQ9vLm2Rt7sWz8Yb4Hq5nJ8cV",
      "  host: example",
      "  port: 80",
      "svc2:",
      "  host: example",
      "  port: 80",
      "",
    ].join("\n");
    const states = new Map([["s.yaml", state(src)]]);
    const p = planChangeSet(cs(replace("s.yaml", block(["  host: example", "  timeout: 5", "  port: 80"], ["x"]))), states, NEW_FILE);
    expect(p.failures[0]?.message).toContain("抜粋の 4 行目は複数行にまたがる値 (秘密鍵の本文など)");
    expect(p.failures[0]?.message).toContain("抜粋の 5 行目は複数行にまたがる値 (秘密鍵など) を伏せた範囲にかかる、[MASKED] を含まない行");
    const report = buildFailureReport(p.failures);
    expect(report).toContain("- 5 行目: [MASKED] を含む行と一緒に使えない行");
    expect(report).toContain("「[MASKED] を含む行と一緒に使えない行」とした行は、[MASKED] を含む行と同じ");
    expect(report).not.toContain("MIIEow");
    expect(report).not.toContain("Xk3pQ9");
    // END の行と伏せ字の行を一緒に入れると一致しない
    const withToken = ["    -----END RSA PRIVATE KEY-----", "  token: [MASKED]", "  host: example", "  port: 80"];
    const bad = planChangeSet(cs(replace("s.yaml", block(withToken, [...withToken.slice(0, 3), "  port: 8080"]))), states, NEW_FILE);
    expect(bad.ok).toBe(false);
    expect(bad.failures[0]?.message).toContain("[MASKED] を含まない行 (END の行など)");
    // 伏せ字の行から始めるか、伏せ字の行を含まなければ END の行も使える
    const fromToken = ["  token: [MASKED]", "  host: example", "  port: 80"];
    const okToken = planChangeSet(cs(replace("s.yaml", block(fromToken, [...fromToken.slice(0, 2), "  port: 8080"]))), states, NEW_FILE);
    expect(okToken.ok).toBe(true);
    expect(text(okToken.outcomes[0]?.afterBytes ?? null)).toBe(src.replace("  port: 80\nsvc2", "  port: 8080\nsvc2"));
  });

  it("文脈にだけ伏せた範囲の行があるときの修正のヒントは、記号の付いた行だけを写すよう明記する", () => {
    const src = [
      "svc1:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    -----END RSA PRIVATE KEY-----",
      "  token: Xk3pQ9vLm2Rt7sWz8Yb4Hq5nJ8cV",
      "  name: a",
      "  zone: b",
      "  host: example",
      "  user: admin",
      "  port: 80",
      "  tail: z",
      "",
    ].join("\n");
    const states = new Map([["s.yaml", state(src)]]);
    const p = planChangeSet(cs(replace("s.yaml", block(["  host: example", "  port: 80"], ["  host: example", "  port: 8080"]))), states, NEW_FILE);
    const report = buildFailureReport(p.failures);
    expect(report).toContain("- 5 行目: [MASKED] を含む行と一緒に使えない行");
    expect(report).toContain("(記号のない前後の文脈の行は含めません)");
    // ヒントどおり記号の付いた行だけを写せば一致する
    const copied = report
      .split("\n")
      .filter((l) => /^[=~!+] +\d+│/.test(l))
      .map((l) => l.slice(l.indexOf("│") + 1));
    expect(copied).toEqual(["  host: example", "  user: admin", "  port: 80"]);
    const ok = planChangeSet(
      cs(replace("s.yaml", block(copied, ["  host: example", "  user: admin", "  port: 8080"]))),
      states,
      NEW_FILE,
    );
    expect(ok.ok).toBe(true);
  });

  it("伏せ字の行と一緒に使えない行にも、見分けにくい文字の注記を残す", () => {
    const src = [
      "svc:",
      "  key: |",
      "    -----BEGIN RSA PRIVATE KEY-----",
      "    MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "    -----END RSA PRIVATE KEY-----",
      "  host: example",
      "",
    ].join("\n");
    const p = planChangeSet(
      cs(replace("s.yaml", block(["    -----END RSA PRIVATE\u3000KEY-----", "  host: example"], ["x"]))),
      new Map([["s.yaml", state(src)]]),
      NEW_FILE,
    );
    const report = buildFailureReport(p.failures);
    expect(report).toContain("- 5 行目: [MASKED] を含む行と一緒に使えない行");
    expect(report).toContain("- 5 行目: 見た目で区別しづらい文字の差です");
    expect(report).not.toContain("MIIEow");
  });

  it("伏せ字があっても複数行にまたがる値のない失敗では、伏せた範囲の行の説明を載せない", () => {
    const src = ["Sub A()", '    pwd = "Hunter2Secret"', "    Open(pwd)", "End Sub", ""].join("\n");
    const p = planChangeSet(
      cs(replace("a.vb", block(['    pwd = "[MASKED]"', "    Opn(pwd)"], ["x"]))),
      new Map([["a.vb", state(src)]]),
      NEW_FILE,
    );
    const report = buildFailureReport(p.failures);
    expect(report).toContain("抜粋の [MASKED] は実際の値を伏せた印です");
    expect(report).not.toContain("複数行にまたがる値");
    expect(report).not.toContain("一緒に使えない行");
  });

  it("複数行にまたがる値のない失敗の依頼には、伏せた範囲の行の例外を載せない", () => {
    const p = planChangeSet(
      cs(replace("a.vb", block(["Sub B()"], ["x"]))),
      new Map([["a.vb", state("Sub A()\nEnd Sub\n")]]),
      NEW_FILE,
    );
    expect(buildFailureReport(p.failures)).not.toContain("伏せた範囲にかかる行");
  });

  it("伏せ字を含む REPLACE が空行の差だけで見つかっても「適用済み」にしない", () => {
    const src = ["Sub A()", '    pwd = "Hunter2Secret"', "    Open(pwd)", "End Sub", ""].join("\n");
    const p = planChangeSet(
      cs(replace("a.vb", block(['    pwd = "[MASKED]"', "    Opn(pwd)"], ['    pwd = "[MASKED]"', "", "    Open(pwd)"]))),
      new Map([["a.vb", state(src)]]),
      NEW_FILE,
    );
    expect(p.ok).toBe(false);
    expect(p.failures[0]?.kind).toBe("block-not-found");
  });
});

describe("report: 伏せ字の注記", () => {
  const run = (path: string, src: string, b: ReplaceBlock) =>
    planChangeSet(cs(replace(path, b)), new Map([[path, state(src)]]), NEW_FILE);
  it("照合仕様の伏せ字の項は、レポートに [MASKED] が出るときだけ載せる", () => {
    const masked = run("Db.vb", DB_VB, block(['        Dim pwd As String = "[MASKED]"', "        Opn(pwd)"], ["x"]));
    expect(buildFailureReport(masked.failures)).toContain("抜粋の [MASKED] は実際の値を伏せた印です");
    const plain = run("Plain.vb", "Module M\n    Sub A()\n    End Sub\nEnd Module\n", block(["    Sub B()"], ["x"]));
    expect(plain.ok).toBe(false);
    expect(buildFailureReport(plain.failures)).not.toContain("[MASKED]");
  });

  it("--literal-masked で [MASKED] の文字のまま書いた数を注記する", () => {
    const plan = planChangeSet(
      cs({ op: "create", path: "mask.ts", line: 1, content: ['export const MASK = "[MASKED]";'] }),
      new Map([["mask.ts", { exists: false, symlink: false, bytes: null }]]),
      NEW_FILE,
      { literalMasked: true },
    );
    expect(plan.ok).toBe(true);
    expect(buildMaskRestoreNote(plan.outcomes, false)).toContain("[MASKED] という文字 1 箇所を、--literal-masked の指定どおりそのまま書き込みます");
    const without = planChangeSet(
      cs({ op: "create", path: "mask.ts", line: 1, content: ['export const MASK = "[MASKED]";'] }),
      new Map([["mask.ts", { exists: false, symlink: false, bytes: null }]]),
      NEW_FILE,
    );
    expect(without.failures[0]?.literalAllowed).toBe(true);
  });
});
