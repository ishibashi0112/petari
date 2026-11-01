/**
 * slnmix build のエラー整形(buildErrors.ts)と MSBuild の場所の決定(msbuildRunner.ts)の単体テスト。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import {
  buildErrorReport,
  displayPath,
  maskValues,
  parseMsbuildErrors,
  resolveErrorFile,
  type BuildError,
} from "../../src/pack/buildErrors.ts";
import { locateMsbuild, msbuildArgs, type MsbuildLocatorDeps } from "../../src/pack/msbuildRunner.ts";

suite("parseMsbuildErrors", () => {
  test("vbc のエラー(行・列・プロジェクト付き)を取り出す", () => {
    const log = [
      "C:\\src\\App\\Forms\\OrderForm.vb(42,13): error BC30451: 'txtFoo' は宣言されていません。アクセスできない保護レベルになっている可能性があります。 [C:\\src\\App\\App.vbproj]",
    ].join("\r\n");
    assert.deepStrictEqual(parseMsbuildErrors(log), [
      {
        origin: "C:\\src\\App\\Forms\\OrderForm.vb",
        line: 42,
        column: 13,
        code: "BC30451",
        message: "'txtFoo' は宣言されていません。アクセスできない保護レベルになっている可能性があります。",
        project: "C:\\src\\App\\App.vbproj",
      },
    ]);
  });

  test("ノード番号の接頭辞・行だけの位置・ツール名のエラーも取り出し、警告と重複は除く", () => {
    const log = [
      "  1>C:\\src\\App\\Module1.vb(7) : error BC30205: ステートメントの終わりを指定してください。 [C:\\src\\App\\App.vbproj]",
      "C:\\src\\App\\Module1.vb(9,1): warning BC42024: 使用されていないローカル変数です。 [C:\\src\\App\\App.vbproj]",
      "MSBUILD : error MSB1009: プロジェクト ファイルが存在しません。",
      "vbc : Command line error BC2006: オプション 'r' には値が必要です。",
      "  1>C:\\src\\App\\Module1.vb(7) : error BC30205: ステートメントの終わりを指定してください。 [C:\\src\\App\\App.vbproj]",
      "ビルドに失敗しました。",
    ].join("\n");
    const errors = parseMsbuildErrors(log);
    assert.deepStrictEqual(
      errors.map((e) => [e.origin, e.line, e.column, e.code]),
      [
        ["C:\\src\\App\\Module1.vb", 7, undefined, "BC30205"],
        ["MSBUILD", undefined, undefined, "MSB1009"],
        ["vbc", undefined, undefined, "BC2006"],
      ],
    );
  });

  test("位置の範囲指定(行-行 / 行,列-列 / 行,列,行,列)は先頭の行と列を使う", () => {
    const log = [
      "a.vb(3-5): error BC1: x",
      "b.vb(3,4-9): error BC2: y",
      "c.vb(3,4,5,6): error BC3: z",
    ].join("\n");
    assert.deepStrictEqual(
      parseMsbuildErrors(log).map((e) => [e.line, e.column]),
      [
        [3, undefined],
        [3, 4],
        [3, 4],
      ],
    );
  });
});

suite("resolveErrorFile / displayPath", () => {
  test("Windows の絶対パスはそのまま、ルート配下なら / 区切りのルート相対で表示する", () => {
    const error: BuildError = { origin: "C:\\src\\App\\Forms\\A.vb", line: 1, code: "BC1", message: "" };
    const file = resolveErrorFile(error);
    assert.strictEqual(file, "C:\\src\\App\\Forms\\A.vb");
    assert.strictEqual(displayPath(file ?? "", "C:\\src"), "App/Forms/A.vb");
    // ルートの外(Link の参照先など)は絶対パスのまま
    assert.strictEqual(displayPath("D:\\shared\\B.vb", "C:\\src"), "D:\\shared\\B.vb");
  });

  test("相対パスはプロジェクトの場所を基準に解決し、ツール名はファイル扱いしない", () => {
    assert.strictEqual(
      resolveErrorFile({ origin: "Forms\\A.vb", code: "BC1", message: "", project: "C:\\src\\App\\App.vbproj" }),
      "C:\\src\\App\\Forms\\A.vb",
    );
    assert.strictEqual(resolveErrorFile({ origin: "MSBUILD", code: "MSB1009", message: "" }), undefined);
    assert.strictEqual(resolveErrorFile({ origin: "Forms\\A.vb", code: "BC1", message: "" }), undefined);
  });
});

suite("buildErrorReport", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const readLines = (p: string): string[] | undefined => (p === "C:\\src\\App\\A.vb" ? lines : undefined);

  test("各エラーに今のファイルの周辺行を「│」区切りの抜粋で付ける", () => {
    const report = buildErrorReport(
      [{ origin: "C:\\src\\App\\A.vb", line: 6, column: 1, code: "BC30451", message: "'x' は宣言されていません。" }],
      "",
      { rootDir: "C:\\src", readLines, contextLines: 2 },
    );
    assert.ok(report.includes("エラーが 1 件出ました"));
    assert.ok(report.includes("### 1. App/A.vb:6 — BC30451\n'x' は宣言されていません。"));
    assert.ok(
      report.includes(
        ["```vb", "  4 │line 4", "  5 │line 5", "> 6 │line 6", "  7 │line 7", "  8 │line 8", "```"].join("\n"),
      ),
      report,
    );
  });

  test("読めないファイル・ツールのエラーは抜粋なし、上限を超えた分は件数だけ書く", () => {
    const errors: BuildError[] = [
      { origin: "C:\\src\\App\\Missing.vb", line: 3, code: "BC1", message: "m1" },
      { origin: "MSBUILD", code: "MSB4025", message: "m2" },
      { origin: "C:\\src\\App\\A.vb", line: 1, code: "BC3", message: "m3" },
    ];
    const report = buildErrorReport(errors, "", { rootDir: "C:\\src", readLines, maxErrors: 2 });
    assert.ok(report.includes("### 1. App/Missing.vb:3 — BC1\nm1\n\n(ファイルを読めなかったため抜粋はありません)"));
    assert.ok(report.includes("### 2. MSBUILD — MSB4025\nm2"));
    assert.ok(!report.includes("m3"));
    assert.ok(report.includes("(ほかに 1 件のエラーは省略しました)"));
  });

  test("エラーを取り出せなかったときはログの末尾を載せる", () => {
    const report = buildErrorReport([], "何かが失敗した\n", { rootDir: "C:\\src", readLines });
    assert.ok(report.includes("エラーの行を取り出せませんでした"));
    assert.ok(report.includes("```\n何かが失敗した\n```"));
  });

  test("mask 指定時は抜粋・本文・ログの末尾の認証情報を伏せる(行番号は変えない)", () => {
    const db = [
      "Module Db",
      "    Sub Connect()",
      '        Dim pwd As String = "Hunter2Secret"',
      '        Dim conn = "Server=db1;Password=p@ss;"',
      "        Opn(pwd)",
      "    End Sub",
      "End Module",
    ];
    const read = (p: string): string[] | undefined => (p === "C:\\src\\Db.vb" ? db : undefined);
    const report = buildErrorReport(
      [{ origin: "C:\\src\\Db.vb", line: 5, code: "BC30451", message: "'Opn' は宣言されていません。Password=p@ss" }],
      "",
      { rootDir: "C:\\src", readLines: read, contextLines: 2, mask: { strict: true } },
    );
    assert.ok(!report.includes("Hunter2Secret"), report);
    assert.ok(!report.includes("p@ss"), report);
    assert.ok(report.includes('  3 │        Dim pwd As String = "[MASKED]"'), report);
    assert.ok(report.includes(">5 │        Opn(pwd)") || report.includes("> 5 │        Opn(pwd)"), report);
    assert.ok(report.includes("[MASKED] はそのまま残し"));

    const tail = buildErrorReport([], "Password=p@ss の接続に失敗\n", {
      rootDir: "C:\\src",
      readLines: read,
      mask: { strict: true },
    });
    assert.ok(!tail.includes("p@ss"), tail);
  });

  test("ファイル名のないエラーの発生元も伏せる", () => {
    const report = buildErrorReport(
      [{ origin: "Data Source=db1;User ID=sa;Password=Hunter2", code: "DB0001", message: "接続に失敗しました" }],
      "",
      { rootDir: "C:\\src", readLines, mask: { strict: true } },
    );
    assert.ok(!report.includes("Hunter2"), report);
  });

  test("パスに見える発生元でも、ファイルとして読めなければ伏せる", () => {
    const report = buildErrorReport(
      [
        {
          origin: "Data Source=.\\SQLEXPRESS;User ID=sa;Password=Hunter2",
          code: "DB0001",
          message: "x",
          project: "C:\\src\\App.vbproj",
        },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => undefined, mask: { strict: true } },
    );
    assert.ok(!report.includes("Hunter2"), report);
  });

  test(".gitignore でパックから除外しているファイルの抜粋は載せない", () => {
    const secret = ['    Public Const DB_PW As String = "Hunter2Pw"', "    Opn()"];
    const report = buildErrorReport(
      [{ origin: "C:\\src\\DbConfig.vb", line: 2, code: "BC30451", message: "'Opn' は宣言されていません。" }],
      "",
      {
        rootDir: "C:\\src",
        readLines: () => secret,
        mask: { strict: true },
        excludedBy: (p) => (p.endsWith("DbConfig.vb") ? "C:\\src\\.gitignore" : undefined),
      },
    );
    assert.ok(!report.includes("Hunter2Pw"), report);
    assert.ok(report.includes("パックから除外しているファイルのため"), report);
  });

  test("抜粋で伏せた値は、エラーの本文の引用からも伏せる", () => {
    const db = ["Module Db", "    Sub A()", "        Dim pwd = Hunter2Secret", "    End Sub", "End Module"];
    const error = { origin: "C:\\src\\Db.vb", line: 3, code: "BC30451", message: "'Hunter2Secret' は宣言されていません。" };
    const report = buildErrorReport([error], "", { rootDir: "C:\\src", readLines: () => db, mask: { strict: true } });
    assert.ok(!report.includes("Hunter2Secret"), report);
    assert.ok(report.includes("'[MASKED]' は宣言されていません。"), report);
    const excluded = buildErrorReport([error], "", {
      rootDir: "C:\\src",
      readLines: () => db,
      mask: { strict: true },
      excludedBy: () => "C:\\src\\.gitignore",
    });
    assert.ok(!excluded.includes("Hunter2Secret"), excluded);
  });

  test("本文が伏せた値の一部 (識別子) を引用しても伏せ、パックで見えている語は伏せない", () => {
    const db = [
      "Module Db",
      "    Sub A()",
      "        Dim pwd = Hunter2Secret.Trim()",
      '        Me.txtPassword.Name = "txtPassword"',
      '        Me.txtPassword.PasswordChar = "*"c',
      '        Dim pwdOpen = "["',
      "    End Sub",
      "End Module",
    ];
    const report = buildErrorReport(
      [
        { origin: "C:\\src\\Db.vb", line: 3, code: "BC30451", message: "'Hunter2Secret' は宣言されていません。" },
        { origin: "C:\\src\\Db.vb", line: 4, code: "BC30260", message: "'txtPassword' は、class 'frmLogin' で既に宣言されています。" },
        {
          origin: "C:\\src\\Db.vb",
          line: 6,
          code: "BC30452",
          message: "演算子 '&' は、型 'String' および 'Object[]' に対して定義されていません。",
        },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => db, mask: { strict: true } },
    );
    assert.ok(!report.includes("Hunter2Secret"), report);
    assert.ok(report.includes("'txtPassword' は、class 'frmLogin' で既に宣言されています。"), report);
    assert.ok(report.includes("演算子 '&' は、型 'String' および 'Object[]' に対して定義されていません。"), report);
  });

  test("行はコンパイラーと同じく単独の CR も 1 行と数え、伏せ方はパックと同じ区切りで決める", () => {
    // readLines は CRLF / LF で分けた行を返す。2 行目に単独の CR がある
    const lines = ["Module M", "    ' old\r    Sub Main()", '        Dim dbPass As String = "Hunt\u2028er2"', "        Foo(", "    End Sub", "End Module"];
    const report = buildErrorReport(
      [{ origin: "C:\\p\\M.vb", line: 6, code: "BC30201", message: "式が必要です。" }],
      "",
      { rootDir: "C:\\p", readLines: () => lines, mask: { strict: true } },
    );
    assert.ok(report.includes("> 6 │        Foo("), report);
    assert.ok(!report.includes("Hunt"), report);
    assert.ok(!report.includes("er2"), report);
  });

  test("ほかのファイルで見えている語は、伏せた値の中の語でも本文から伏せない", () => {
    const files: Record<string, string[]> = {
      "C:\\src\\FrmLogin.Designer.vb": ["Partial Class FrmLogin", '    Me.lblUser.Text = "UserName"', "End Class"],
      "C:\\src\\LoginService.vb": ["Module LoginService", "    Function Ok(u As Account) As Boolean", '        Return u.UserName <> ""', "    End Function", "End Module"],
    };
    const report = buildErrorReport(
      [
        { origin: "C:\\src\\FrmLogin.Designer.vb", line: 2, code: "BC30002", message: "型 'X' が定義されていません。" },
        { origin: "C:\\src\\LoginService.vb", line: 3, code: "BC30456", message: "'UserName' は 'Account' のメンバーではありません。" },
      ],
      "",
      { rootDir: "C:\\src", readLines: (p) => files[p], mask: { strict: true } },
    );
    assert.ok(report.includes("'UserName' は 'Account' のメンバーではありません。"), report);
  });

  test("伏せた値は、中の語がすべてほかの行で見えていても値ごと本文から伏せる", () => {
    const form = [
      "Partial Class FrmLogin",
      '    Me.lblCity.Text = "Kyoto"',
      '    Me.lblDept.Text = "Sales"',
      '    Me.lblYear.Text = "2024"',
      '    Me.txtPassword.Text = "Kyoto-Sales-2024"',
      '    Dim password As String = "P@$$w0rd!23"',
      "End Class",
    ];
    const errors = [
      { origin: "C:\\src\\FrmLogin.vb", line: 5, code: "CA1303", message: 'リテラルを渡しています: "Kyoto-Sales-2024"' },
      { origin: "C:\\src\\FrmLogin.vb", line: 6, code: "CA1303", message: "リテラルを渡しています: 'P@$$w0rd!23'" },
    ];
    const report = buildErrorReport(errors, "", { rootDir: "C:\\src", readLines: () => form, mask: { strict: true } });
    assert.ok(!report.includes("Kyoto-Sales-2024"), report);
    assert.ok(report.includes('リテラルを渡しています: "[MASKED]"'), report);
    assert.ok(!report.includes("w0rd"), report);
    assert.ok(report.includes("リテラルを渡しています: '[MASKED]'"), report);
    assert.ok(report.includes('Me.lblCity.Text = "Kyoto"'), report);
    // 値のあるファイルがパックから除外され、語だけがほかのファイルに見えている
    const files: Record<string, string[]> = {
      "C:\\src\\Secrets.vb": ["Module Secrets", '    Me.txtPassword.Text = "Kyoto-Sales-2024"', "End Module"],
      "C:\\src\\Labels.vb": ["Module Labels", '    Dim a = "Kyoto", b = "Sales", c = "2024"', "End Module"],
    };
    const excluded = buildErrorReport(
      [
        { origin: "C:\\src\\Secrets.vb", line: 2, code: "CA1303", message: 'リテラルを渡しています: "Kyoto-Sales-2024"' },
        { origin: "C:\\src\\Labels.vb", line: 2, code: "BC42024", message: "使われていない変数" },
      ],
      "",
      {
        rootDir: "C:\\src",
        readLines: (p) => files[p],
        mask: { strict: true },
        excludedBy: (p) => (p.endsWith("Secrets.vb") ? "C:\\src\\.gitignore" : undefined),
      },
    );
    assert.ok(!excluded.includes("Kyoto-Sales-2024"), excluded);
  });

  test("エラーのないファイルの宣言の既定値を本文が引用しても伏せる", () => {
    // コンパイラーは呼び出し先のシグネチャを省略可能な引数の既定値ごと引用する
    const form = ["Public Class Form1", "    Sub A()", "        Db.Open()", "    End Sub", "End Class"];
    const report = buildErrorReport(
      [
        {
          origin: "C:\\src\\Form1.vb",
          line: 3,
          code: "BC30455",
          message:
            "パラメーター 'server' に対して引数が指定されていません ('Public Function Open(server As String, [password As String = \"Zq9TigerSecret\"]) As Boolean')。",
        },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => form, mask: { strict: true } },
    );
    assert.ok(!report.includes("Zq9TigerSecret"), report);
    assert.ok(report.includes("[password As String = \"[MASKED]\"]"), report);
    assert.ok(report.includes("パラメーター 'server' に対して引数が指定されていません"), report);
  });

  test("定数を参照する既定値もコンパイラーが値に置き換えて引用するため、名前に関わらず伏せる", () => {
    const report = buildErrorReport(
      [
        {
          origin: "C:\\src\\Form1.vb",
          line: 1,
          code: "BC30455",
          message:
            "Argument not specified for parameter 'server' of 'Public Sub Connect(server As String, [key As String = \"k3yV4lu3\"])'.",
        },
        {
          origin: "C:\\src\\Form1.vb",
          line: 1,
          code: "BC30455",
          message: "Argument not specified for parameter 'id' of 'Public Sub M(id As Integer, [user As String = \"a\"], [n As Integer = 1])'.",
        },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => ["Db.Connect()"], mask: { strict: true } },
    );
    assert.ok(!report.includes("k3yV4lu3"), report);
    assert.ok(report.includes('[key As String = "[MASKED]"]'), report);
    // 短い既定値はその位置だけ伏せる(本文のほかの語を伏せない)
    assert.ok(
      report.includes("Argument not specified for parameter 'id' of 'Public Sub M(id As Integer, [user As String = \"[MASKED]\"], [n As Integer = 1])'."),
      report,
    );
  });

  test("予約語の引数名 ([Error]) の既定値も伏せる", () => {
    const report = buildErrorReport(
      [
        { origin: "C:\\src\\F.vb", line: 1, code: "BC30057", message: "Too many arguments to 'Public Sub Connect([[Error] As String = \"Hunter2Secret\"])'." },
        { origin: "C:\\src\\F.vb", line: 1, code: "BC30057", message: "Too many arguments to 'Public Sub M([ByRef [Date] As String = \"Kp7MoonPass\"])'." },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => ["Db.Connect(1, 2)"], mask: { strict: true } },
    );
    assert.ok(!report.includes("Hunter2Secret"), report);
    assert.ok(!report.includes("Kp7MoonPass"), report);
    assert.ok(report.includes("Too many arguments to 'Public Sub Connect([[Error] As String = \"[MASKED]\"])'."), report);
  });

  test("文の形の伏せた値 (ラベルの文言・SQL) の語で、本文のふつうの語を伏せない", () => {
    const lines = [
      "Public Class FrmLogin",
      '    Sub ShowError()',
      '        lblPasswordError.Text = "The password is not correct for this type of account"',
      '        Dim sqlPassword As String = "select user_id from m_user where pwd = @p and del = 0"',
      "    End Sub",
      "",
      "",
      "",
      "",
      "",
      "    Sub A()",
      "        Dim x = Foo + 1",
      "    End Sub",
      "End Class",
    ];
    const report = buildErrorReport(
      [
        { origin: "C:\\src\\FrmLogin.vb", line: 12, code: "BC30452", message: "Operator '+' is not defined for types 'String' and 'Integer'." },
        { origin: "C:\\src\\FrmLogin.vb", line: 12, code: "BC30451", message: "'Foo' is not declared. It may be inaccessible due to its protection level." },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => lines, mask: { strict: true } },
    );
    assert.ok(report.includes("Operator '+' is not defined for types 'String' and 'Integer'."), report);
    assert.ok(report.includes("'Foo' is not declared. It may be inaccessible due to its protection level."), report);
  });

  test("伏せた値の中の識別子らしい語は、引用符の形によらず本文から伏せる", () => {
    const lines = ["Module Db", "    Sub A()", "        Dim pwd = Hunter2Secret.Trim()", "    End Sub", "End Module"];
    const messages = [
      // ' を含む語で引用の組がずれる(フランス語)
      "'string' ne contient pas de définition pour 'Hunter2Secret' et aucune méthode d'extension accessible 'Hunter2Secret' n'a été trouvée",
      // ドイツ語の引用符
      "„Hunter2Secret“ ist nicht deklariert.",
      // 引用符なし
      "Hunter2Secretは宣言されていません。",
      // 伏せた位置を対応づけられない本文(' を空白にして伏せる)
      "'Hunter2Secret' is not declared. -----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY-----",
    ];
    for (const message of messages) {
      const report = buildErrorReport([{ origin: "C:\\src\\Db.vb", line: 3, code: "BC30451", message }], "", {
        rootDir: "C:\\src",
        readLines: () => lines,
        mask: { strict: true },
      });
      assert.ok(!report.includes("Hunter2Secret"), report);
    }
  });

  test("長い文字列の一部に同じ並びがあるだけなら、伏せた値は見えているとみなさない", () => {
    const lines = [
      "Module M",
      '    Dim title = "Kyoto-Sales-2024 Report"',
      '    Dim password As String = "Sales-2024"',
      '    Dim note = "abc def ghi"',
      '    Dim secret As String = "def ghi"',
      "End Module",
    ];
    const report = buildErrorReport(
      [
        { origin: "C:\\src\\M.vb", line: 3, code: "CA1303", message: 'リテラルを渡しています: "Sales-2024"' },
        { origin: "C:\\src\\M.vb", line: 5, code: "CA1303", message: 'リテラルを渡しています: "def ghi"' },
      ],
      "",
      { rootDir: "C:\\src", readLines: () => lines, mask: { strict: true } },
    );
    assert.ok(!report.includes('"Sales-2024"'), report);
    assert.ok(!report.includes('"def ghi"'), report);
    assert.ok(report.includes('Dim title = "Kyoto-Sales-2024 Report"'), report);
  });

  test("generic の追加ディレクトリでない .vb は、パックと同じく VB のソースとしてだけ伏せる", () => {
    const lines = ["Module M", "    Sub A()", "        user.Password = txtPasword.Text", "    End Sub", "End Module"];
    const error = { origin: "C:\\src\\M.vb", line: 3, code: "BC30451", message: "'txtPasword' は宣言されていません。" };
    const asPack = buildErrorReport([error], "", {
      rootDir: "C:\\src",
      readLines: () => lines,
      mask: { strict: true },
      genericTextFor: () => false,
    });
    assert.ok(asPack.includes("> 3 │        user.Password = txtPasword.Text"), asPack);
    assert.ok(asPack.includes("'txtPasword' は宣言されていません。"), asPack);
    const generic = buildErrorReport([error], "", {
      rootDir: "C:\\src",
      readLines: () => lines,
      mask: { strict: true },
      genericTextFor: () => true,
    });
    assert.ok(!generic.includes("txtPasword"), generic);
  });

  test("本文の日本語に続く引用でも伏せる", () => {
    const lines = ["Module M", "    Dim pwd = Hunter2Secret", "End Module"];
    const report = buildErrorReport(
      [{ origin: "C:\\src\\M.vb", line: 2, code: "BC30451", message: "Hunter2Secretは宣言されていません。" }],
      "",
      { rootDir: "C:\\src", readLines: () => lines, mask: { strict: true } },
    );
    assert.ok(!report.includes("Hunter2Secret"), report);
  });

  test("maskValues は短い値で別の語の一部を伏せない", () => {
    assert.strictEqual(maskValues("'sa' usage sa_x sa.", ["sa"]), "'[MASKED]' usage sa_x [MASKED].");
    assert.strictEqual(maskValues("p@ss!", ["p@ss!"]), "[MASKED]");
  });

  test("同じファイルのエラーが続いても、ファイルは 1 回だけ読んで伏せる", () => {
    let reads = 0;
    const report = buildErrorReport(
      [1, 2, 3].map((line) => ({ origin: "C:\\src\\A.vb", line, code: "BC1", message: "x" })),
      "",
      {
        rootDir: "C:\\src",
        readLines: () => {
          reads += 1;
          return ["a", "b", "c"];
        },
        mask: { strict: true },
      },
    );
    assert.strictEqual(reads, 1);
    assert.ok(report.includes("### 3."));
  });

  test("mask 省略時(--no-mask)は伏せない", () => {
    const report = buildErrorReport(
      [{ origin: "C:\\src\\App\\A.vb", line: 6, code: "BC1", message: "Password=p@ss" }],
      "",
      { rootDir: "C:\\src", readLines },
    );
    assert.ok(report.includes("Password=p@ss"));
    assert.ok(!report.includes("[MASKED] はそのまま残し"));
  });
});

suite("locateMsbuild", () => {
  function deps(files: string[], vswhereOutput?: string, platform: NodeJS.Platform = "win32"): MsbuildLocatorDeps {
    return {
      platform,
      env: { "ProgramFiles(x86)": "C:\\Program Files (x86)", WINDIR: "C:\\Windows" },
      isFile: (p) => files.includes(p),
      runVswhere: () => vswhereOutput,
    };
  }
  const VSWHERE = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  const VS2022 = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe";
  const MSBUILD12 = "C:\\Program Files (x86)\\MSBuild\\12.0\\Bin\\MSBuild.exe";
  const FRAMEWORK64 = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\MSBuild.exe";

  test("--msbuild の指定を最優先する(Windows 以外でも使える)", () => {
    assert.deepStrictEqual(locateMsbuild("/usr/bin/msbuild", deps([], undefined, "darwin")), {
      kind: "found",
      path: "/usr/bin/msbuild",
      source: "--msbuild",
    });
  });

  test("vswhere が返した実在する MSBuild を使う", () => {
    const found = locateMsbuild(undefined, deps([VSWHERE, VS2022, MSBUILD12], `${VS2022}\r\n`));
    assert.deepStrictEqual(found, { kind: "found", path: VS2022, source: "vswhere" });
  });

  test("vswhere が無ければ VS 2013 の MSBuild、それも無ければ .NET Framework 4 の MSBuild", () => {
    assert.deepStrictEqual(locateMsbuild(undefined, deps([MSBUILD12, FRAMEWORK64])), {
      kind: "found",
      path: MSBUILD12,
      source: "MSBuild 12.0(VS 2013)",
    });
    assert.deepStrictEqual(locateMsbuild(undefined, deps([FRAMEWORK64])), {
      kind: "found",
      path: FRAMEWORK64,
      source: ".NET Framework 4",
    });
  });

  test("見つからなければ確かめた場所と --msbuild を案内する。Windows 以外は自動検出しない", () => {
    const missing = locateMsbuild(undefined, deps([VSWHERE], ""));
    assert.strictEqual(missing.kind, "error");
    assert.ok(missing.kind === "error" && missing.message.includes(MSBUILD12) && missing.message.includes("--msbuild"));
    const mac = locateMsbuild(undefined, deps([], undefined, "darwin"));
    assert.ok(mac.kind === "error" && mac.message.includes("--msbuild"));
  });
});

suite("msbuildArgs", () => {
  test("エラーだけを UTF-8 のログへ書かせ、構成は指定したときだけ渡す", () => {
    assert.deepStrictEqual(msbuildArgs("C:\\src\\App.sln", { logFile: "C:\\tmp\\errors.log" }), [
      "C:\\src\\App.sln",
      "/nologo",
      "/m",
      "/v:minimal",
      "/fl",
      "/flp:LogFile=C:\\tmp\\errors.log;ErrorsOnly;Encoding=UTF-8",
    ]);
    assert.ok(
      msbuildArgs("App.sln", { logFile: "e.log", configuration: "Release" }).includes("/p:Configuration=Release"),
    );
  });
});
