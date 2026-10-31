/**
 * mask.ts の maskCredentials (slnmix の credentialMasker の写し) の単体テスト。
 * slnmix の src/test/credentialMasker.test.ts を写したもの (判定を揃えるため)。
 * 実業務プロジェクト(NBOM040)で実際に検出された形を含む
 * VB レガシーコードのパターンで検証する。
 */

import { assert, describe, it } from "vitest";
import { maskCredentials } from "../src/core/mask.ts";

const VB = { vbSource: true };
const GENERIC = { vbSource: false };

describe("credentialMasker: VB 変数代入リテラル", () => {
  it("パスワード系変数への代入をマスクする(実例由来)", () => {
    const result = maskCredentials(
      'Public Pub_KMSS_DB_Pswd As String = "inf001"',
      VB,
    );
    assert.strictEqual(
      result.content,
      'Public Pub_KMSS_DB_Pswd As String = "[MASKED]"',
    );
    assert.strictEqual(result.findings[0]?.kind, "パスワード");
  });

  it("ユーザーID系変数への代入をマスクする(実例由来)", () => {
    const result = maskCredentials('wk_Bics_User = "komori"', VB);
    assert.strictEqual(result.content, 'wk_Bics_User = "[MASKED]"');
    assert.strictEqual(result.findings[0]?.kind, "ユーザーID");
  });

  it("変数・式からの代入(リテラルでない)は触らない", () => {
    const code = 'Pub_DB_Para_Nbom.DB_Pswd = wk_DbPara(1)';
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });

  it("空文字リテラルは触らない", () => {
    const code = 'Public Pub_LoginUserName As String = ""';
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });

  it("認証と無関係な変数名は触らない", () => {
    const code = [
      'ComboBox_Unit.ValueMember = "UNIT_ID"',
      'wk_Row("UNIT_ID") = ""',
      '.ActiveSheet.Columns(0).Label = "ﾕﾆｯﾄｺｰﾄﾞ"',
      'Pub_KMSS_DB_Conn As String = "KSIS01"',
    ].join("\n");
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });
});

describe("credentialMasker: VB 文字列リテラル内の接続文字列", () => {
  it("PWD= / User ID= の値をマスクする(実例由来)", () => {
    const code = [
      'wk_ConStr = wk_ConStr & "Server=SSDB01;"',
      'wk_ConStr = wk_ConStr & "User ID=sales_admin;"',
      'wk_ConStr = wk_ConStr & "PWD=kss2015_Admin;"',
      'wk_ConStr = wk_ConStr & "Initial Catalog=kss;"',
    ].join("\n");
    const result = maskCredentials(code, VB);
    assert.ok(result.content.includes('"User ID=[MASKED];"'));
    assert.ok(result.content.includes('"PWD=[MASKED];"'));
    // サーバー名・カタログ名は認証情報ではないため残す
    assert.ok(result.content.includes('"Server=SSDB01;"'));
    assert.ok(result.content.includes('"Initial Catalog=kss;"'));
    assert.strictEqual(result.findings.length, 2);
  });

  it("値が変数連結(リテラル外)の場合は触らない", () => {
    const code =
      'wk_ConStr = wk_ConStr & "Password=" & In_Pswd & ";"';
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });

  it("SQL のバインド変数(:NAME)や比較式は触らない", () => {
    const code = [
      'wk_Sql = wk_Sql & " Where UNIT_ID = :UNIT_ID"',
      "'     TNTO = '\" & In_Tnto & \"'\"",
    ].join("\n");
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });
});

describe("credentialMasker: 非 VB ファイル(config / XML)", () => {
  it("接続文字列属性の Password / User ID をマスクする", () => {
    const xml =
      '<add name="Db" connectionString="Data Source=SV1;User ID=sa;Password=p@ss w0rd;" />';
    const result = maskCredentials(xml, GENERIC);
    assert.ok(result.content.includes("User ID=[MASKED];"));
    assert.ok(result.content.includes("Password=[MASKED];"));
    assert.ok(result.content.includes("Data Source=SV1;"));
  });

  it('password="値" の属性形式をマスクする', () => {
    const xml = '<credential username="admin" password="secret123" />';
    const result = maskCredentials(xml, GENERIC);
    assert.ok(result.content.includes('username="[MASKED]"'));
    assert.ok(result.content.includes('password="[MASKED]"'));
  });
});

describe("credentialMasker: 設定ファイルのキーと値", () => {
  const LOOSE = { vbSource: false, strict: false };

  it("appSettings の秘密系キーの値を伏せる(key と value の順はどちらでも)", () => {
    const config = [
      "<appSettings>",
      '  <add key="DbPassword" value="Hunter2Secret" />',
      '  <add value="Tok3nValue" key="ApiToken"/>',
      '  <add key="SmtpUserId" value="mailer" />',
      '  <add key="Theme" value="Dark" />',
      '  <add key="Password" value="" />',
      '  <add key="Password"',
      '       value="Hunter2',
      '  Secret" />',
      "</appSettings>",
    ].join("\n");
    const result = maskCredentials(config, LOOSE);
    assert.strictEqual(
      result.content,
      [
        "<appSettings>",
        '  <add key="DbPassword" value="[MASKED]" />',
        '  <add value="[MASKED]" key="ApiToken"/>',
        '  <add key="SmtpUserId" value="[MASKED]" />',
        '  <add key="Theme" value="Dark" />',
        '  <add key="Password" value="" />',
        '  <add key="Password"',
        '       value="[MASKED]" />',
        "</appSettings>",
      ].join("\n"),
    );
    assert.strictEqual(result.findings.length, 4);
  });

  it("My.Settings(app.config / Settings.settings)の秘密系の設定の値を伏せる", () => {
    const config = [
      '<setting name="DbPassword" serializeAs="String">',
      "  <value>Hunter2Secret</value>",
      "</setting>",
      '<setting name="Title" serializeAs="String">',
      "  <value>Sales</value>",
      "</setting>",
      '<Setting Name="ApiKey" Type="System.String" Scope="Application">',
      '  <Value Profile="(Default)">',
      "    k3yV4lu3",
      "  </Value>",
      "</Setting>",
      '<setting name="Password" serializeAs="String">',
      "  <value />",
      "</setting>",
    ].join("\n");
    assert.strictEqual(
      maskCredentials(config, LOOSE).content,
      [
        '<setting name="DbPassword" serializeAs="String">',
        "  <value>[MASKED]</value>",
        "</setting>",
        '<setting name="Title" serializeAs="String">',
        "  <value>Sales</value>",
        "</setting>",
        '<Setting Name="ApiKey" Type="System.String" Scope="Application">',
        '  <Value Profile="(Default)">',
        "    [MASKED]",
        "  </Value>",
        "</Setting>",
        '<setting name="Password" serializeAs="String">',
        "  <value />",
        "</setting>",
      ].join("\n"),
    );
  });

  it("前に英数字以外が付いたキー(DB_PASSWORD= など)と単一引用符の値も伏せる", () => {
    const env = ["DB_PASSWORD=Hunter2", "export SECRET_TOKEN=zzz", "COMPASS=north", "BYPASS=1", "MY_UID=42"].join("\n");
    assert.strictEqual(
      maskCredentials(env, LOOSE).content,
      ["DB_PASSWORD=[MASKED]", "export SECRET_TOKEN=[MASKED]", "COMPASS=north", "BYPASS=1", "MY_UID=[MASKED]"].join("\n"),
    );
    assert.strictEqual(
      maskCredentials("DB_PASSWORD = 'Hunter2'\nname = 'it''s'", LOOSE).content,
      "DB_PASSWORD = '[MASKED]'\nname = 'it''s'",
    );
    // 接続文字列の単一引用符の値('' は ' のエスケープ。閉じていなければ区切りまで)
    assert.strictEqual(
      maskCredentials("Server=srv;Password='ab''cd;ef';Database=x\nUser ID='sa\nPwd='Hunter2", LOOSE).content,
      "Server=srv;Password='[MASKED]';Database=x\nUser ID=[MASKED]\nPwd=[MASKED]",
    );
  });

  it("キー名の一部に秘密系の語を含むだけのもの・コード・表示の文言は伏せない", () => {
    const json = [
      '{ "jsonwebtoken": "^9.0.2", "passport": "^0.7.0",',
      '  "login.passwordPlaceholder": "8 chars", "errors.tokenExpired": "expired",',
      '  "password": "パスワード", "Password": "Password" }',
    ].join("\n");
    assert.strictEqual(maskCredentials(json, LOOSE).content, json);
    const code = ["this._token = token;", "const next_token = this.refresh(token)", "first_pass = True"].join("\n");
    assert.strictEqual(maskCredentials(code, LOOSE).content, code);
    const config = '<add key="BypassProxy" value="true" />\n<add key="PasswordMinLength" value="8" />';
    assert.strictEqual(maskCredentials(config, LOOSE).content, config);
    // 字句解析の token・HTTP の credentials・書式だけの値・字下げした引数
    const lexer = [
      '{ token: "keyword", defaultToken: "invalid", "token": "token#module-token" }',
      '{cases:{"@keywords":{token:"keyword.$0"},"@reserved":{token:"constant.reserved.$0"}}}',
      'if(u===" ")this.whitespace_before_token=" ";this.next_token="ident";',
      "const mode: RequestCredentials = 'omit';",
      "    user_pass = '%s:%s' % (user, passwd)",
      "    credentials = '{0}:{1}'.format(a, b)",
      "    def f(self, credentials=None, secure=None):",
      "        login(user='klem', debug=None,",
    ].join("\n");
    assert.strictEqual(maskCredentials(lexer, LOOSE).content, lexer);
  });

  it("ODBC の {...} で囲んだ値は伏せ、番号の差し込み({0})だけの値は伏せない", () => {
    assert.strictEqual(
      maskCredentials("Driver={SQL Server};Server=db;Uid={sa};Pwd={Hunter2Secret};", LOOSE).content,
      "Driver={SQL Server};Server=db;Uid=[MASKED];Pwd=[MASKED];",
    );
    assert.strictEqual(
      maskCredentials('password="{Hunter2}"\nconn = "Server=x;Password={0};User ID={1,-8}"', LOOSE).content,
      'password="[MASKED]"\nconn = "Server=x;Password={0};User ID={1,-8}"',
    );
    assert.strictEqual(
      maskCredentials('Dim cs = "Driver={SQL Server};Pwd={Hunter2Secret};"', { vbSource: true, strict: false }).content,
      'Dim cs = "Driver={SQL Server};Pwd=[MASKED];"',
    );
  });

  it("前に語が付いたキーの空白を含む値(パスフレーズ)も伏せる", () => {
    const code = [
      'csb.Password = "correct horse battery";',
      'options.Password = "パスワード2024";',
      '--password="my secret phrase"',
      'spring.datasource.password="correct horse"',
    ].join("\n");
    assert.strictEqual(
      maskCredentials(code, LOOSE).content,
      ['csb.Password = "[MASKED]";', 'options.Password = "[MASKED]";', '--password="[MASKED]"', 'spring.datasource.password="[MASKED]"'].join(
        "\n",
      ),
    );
  });

  it("空の文字列が 2 つ並ぶ行を 1 つの値と読まない・同じ値を二重に数えない", () => {
    const code = [
      'If password = "" OrElse userId = "" Then',
      'def connect(host="localhost", user="", password="", db=""):',
      'public void Login(string password = "", string domain = "") {}',
      '<input pwd="" class="">',
      'type = hidden ? "password" : "text";',
      'x = cond ? password : "text";',
    ].join("\n");
    assert.strictEqual(maskCredentials(code, LOOSE).content, code);
    const env = maskCredentials('secret=Hunter2\npassword="Hunter2"\nPassword=Hunter2;Server=x', LOOSE);
    assert.strictEqual(env.content, 'secret=[MASKED]\npassword="[MASKED]"\nPassword=[MASKED];Server=x');
    assert.strictEqual(env.findings.length, 3);
    assert.strictEqual(maskCredentials('password = @"ab""cdefgh";', LOOSE).content, 'password = @"[MASKED]";');
  });

  it("C# / JSON の文字列の中で \\\" で囲んだ接続文字列の値も伏せる", () => {
    assert.strictEqual(
      maskCredentials('var cs = "Server=x;Password=\\"Hun;ter2\\";Database=y";', LOOSE).content,
      'var cs = "Server=x;Password=\\"[MASKED]\\";Database=y";',
    );
  });

  it("リソース(.resx)の秘密系の名前の値を伏せる(表示の文言は除く)", () => {
    const resx = [
      '<data name="DbPassword" xml:space="preserve">',
      "  <value>Hunter2Secret</value>",
      "</data>",
      '<data name="Password" xml:space="preserve">',
      "  <value>パスワード</value>",
      "</data>",
      '<data name="lblPassword.Text" xml:space="preserve">',
      "  <value>Hunter2</value>",
      "</data>",
    ].join("\n");
    assert.strictEqual(maskCredentials(resx, LOOSE).content, resx.replace("Hunter2Secret", "[MASKED]"));
  });

  it("C# の逐語的・補間文字列の値も伏せる", () => {
    assert.strictEqual(
      maskCredentials('var pwd = @"Zq9\\Secret";\nvar password = $"Zq9{x}";\nvar uid = @"sa";', LOOSE).content,
      'var pwd = @"[MASKED]";\nvar password = $"[MASKED]";\nvar uid = @"[MASKED]";',
    );
  });

  it("token / credentials は値が秘密らしいとき・キーに別の秘密系の語があるときだけ伏せる", () => {
    assert.strictEqual(
      maskCredentials('{ "token": "ghp_9fK2aQ7xZ1", "authToken": "a1b2c3d4e5", "secretToken": "x" }', LOOSE).content,
      '{ "token": "[MASKED]", "authToken": "[MASKED]", "secretToken": "[MASKED]" }',
    );
    assert.strictEqual(
      maskCredentials("GITHUB_TOKEN=ghp_9fK2aQ7xZ1\nTOKEN_TYPE=bearer\nAUTH_TOKEN=short", LOOSE).content,
      "GITHUB_TOKEN=[MASKED]\nTOKEN_TYPE=bearer\nAUTH_TOKEN=short",
    );
    assert.strictEqual(
      maskCredentials('this.db_password = "x"; cfg.access_token = "a1b2c3d4e5f6"; this.username = "sa"; x.token="abc123"', LOOSE).content,
      'this.db_password = "[MASKED]"; cfg.access_token = "[MASKED]"; this.username = "[MASKED]"; x.token="[MASKED]"',
    );
  });

  it("JSON などの秘密系キーの文字列の値を伏せる", () => {
    const json = '{ "Password": "Hun\\"ter2", "ApiKey": "abc123", "Name": "x", "tokenTtl": 30, \'db_pass\': \'p@ss\' }';
    assert.strictEqual(
      maskCredentials(json, LOOSE).content,
      '{ "Password": "[MASKED]", "ApiKey": "[MASKED]", "Name": "x", "tokenTtl": 30, \'db_pass\': \'[MASKED]\' }',
    );
  });

  it("${NAME} だけの値は伏せず、${NAME:-既定値} の既定値は伏せる", () => {
    assert.strictEqual(
      maskCredentials("spring.datasource.password=${DB_PASSWORD}\nDB_PASSWORD=${SECRET_PW}", LOOSE).content,
      "spring.datasource.password=${DB_PASSWORD}\nDB_PASSWORD=${SECRET_PW}",
    );
    for (const input of [
      "spring.datasource.password=${DB_PASSWORD:Hunter2Secret}",
      "Server=db;Password=${DB_PASSWORD:-Hunter2Secret};Database=x",
      'password = "${DB_PASSWORD:-Hunter2Secret}"',
      '<add name="db" connectionString="Server=db;Password=${PW:-Hunter2Secret};" />',
    ]) {
      assert.ok(!maskCredentials(input, LOOSE).content.includes("Hunter2"), input);
    }
    assert.ok(!maskCredentials('Dim s = "Server=db;Password=${PW:-Hunter2Secret};"', { vbSource: true, strict: false }).content.includes("Hunter2"));
  });

  it("コメントの次の行・YAML の : のキーも伏せる(三項演算子は伏せない)", () => {
    for (const input of [
      '{\n  // DB settings\n  "Password": "hunter2"\n}',
      "'default': {\n  # PostgreSQL\n  'PASSWORD': 'hunter2',",
      "host: 'x', // c\n  password: 'hunter2',",
      'db:\n  password: "hunter2"',
      'db:\r\n  password: "hunter2"',
    ]) {
      assert.ok(!maskCredentials(input, LOOSE).content.includes("hunter2"), input);
    }
    const ternary = 'const t = cond ? "password" : "text";\nconst u = cond\n  ? "password"\n  : "text";';
    assert.strictEqual(maskCredentials(ternary, LOOSE).content, ternary);
  });

  it("早く閉じた引用符・\\' の後ろの値も伏せる", () => {
    assert.ok(!maskCredentials("Server=x;Password='ab'cd;Database=y", LOOSE).content.includes("cd;"));
    assert.ok(!maskCredentials("const password = 'it\\'s-Hunter2';", LOOSE).content.includes("Hunter2"));
    assert.strictEqual(
      maskCredentials("Server=x;Password='a;b';Database=y", LOOSE).content,
      "Server=x;Password='[MASKED]';Database=y",
    );
  });

  it("行末の空白のある値を二重に数えない", () => {
    const result = maskCredentials("PASSWORD=Hunter2 \nAPI_KEY=abc123\t", LOOSE);
    assert.strictEqual(result.content, "PASSWORD=[MASKED] \nAPI_KEY=[MASKED]\t");
    assert.strictEqual(result.findings.length, 2);
  });

  it("真偽値の設定と、ユーザー ID 系のリソースの表示の文言は伏せない", () => {
    for (const input of [
      '<add key="EncryptPassword" value="false"/>',
      '<add key="RequireToken" value="true"/>',
      '<setting name="SavePassword" serializeAs="String"><value>True</value></setting>',
      '{ "SavePassword": "true" }',
      '<data name="UserId" xml:space="preserve"><value>User ID</value></data>',
      '<data name="UserName" xml:space="preserve"><value>Name</value></data>',
    ]) {
      assert.strictEqual(maskCredentials(input, LOOSE).content, input, input);
    }
    const vb = [
      '<Global.System.Configuration.DefaultSettingValueAttribute("True")>  _',
      "Public Property SavePassword() As Boolean",
    ].join("\n");
    assert.strictEqual(maskCredentials(vb, { vbSource: true, strict: false }).content, vb);
    assert.ok(!maskCredentials('<add key="RequireToken" value="a1b2c3d4e5f6"/>', LOOSE).content.includes("a1b2"));
    assert.ok(!maskCredentials('<add key="DbPassword" value="truthy1"/>', LOOSE).content.includes("truthy1"));
    assert.ok(!maskCredentials('<data name="UserId" xml:space="preserve"><value>sa</value></data>', LOOSE).content.includes(">sa<"));
  });

  it("キーが秘密系で ; を含む値は全体を伏せる(接続文字列の形の値は ; まで)", () => {
    assert.strictEqual(
      maskCredentials("DB_PASSWORD=Hunter2;Server=x\nMYSQL_PWD=Hunter2; charset=utf8", LOOSE).content,
      "DB_PASSWORD=[MASKED]\nMYSQL_PWD=[MASKED]",
    );
    assert.strictEqual(
      maskCredentials("ConnectionString=Server=x;Password=Hunter2;Database=y", LOOSE).content,
      "ConnectionString=Server=x;Password=[MASKED];Database=y",
    );
  });

  it("日本語のキーは語の数によらず秘密系として伏せる", () => {
    assert.ok(!maskCredentials('{ "パスワード": "Hunter2" }', LOOSE).content.includes("Hunter2"));
    assert.ok(!maskCredentials('{ "DB接続パスワード": "abc" }', LOOSE).content.includes("abc"));
  });
});

describe("credentialMasker: VB の連結で続く秘密の値", () => {
  const LOOSE_VB = { vbSource: true, strict: false };

  it("秘密として伏せたリテラルに連結で続くリテラルも伏せる", () => {
    const vb = [
      'Dim password As String = "Hunter2Secret" & _',
      '    "morepart"',
      'pwd = "abc" & vbCrLf & "def" + "ghi"',
      "apiKey = \"part1\" _",
      '    & "part2"',
      'pwd = "abc" & _ \' 続き',
      '    "def"',
    ].join("\n");
    assert.strictEqual(
      maskCredentials(vb, LOOSE_VB).content,
      [
        'Dim password As String = "[MASKED]" & _',
        '    "[MASKED]"',
        'pwd = "[MASKED]" & vbCrLf & "[MASKED]" + "[MASKED]"',
        'apiKey = "[MASKED]" _',
        '    & "[MASKED]"',
        'pwd = "[MASKED]" & _ \' 続き',
        '    "[MASKED]"',
      ].join("\n"),
    );
  });

  it("間に変数や別の文があれば続きとみなさない", () => {
    const vb = [
      'pwd = "abc" & userName & "def"',
      'pwd = "abc"',
      'title = "Sales"',
      'msg = "Hello" & _',
      '    "World"',
    ].join("\n");
    assert.strictEqual(
      maskCredentials(vb, LOOSE_VB).content,
      ['pwd = "[MASKED]" & userName & "def"', 'pwd = "[MASKED]"', 'title = "Sales"', 'msg = "Hello" & _', '    "World"'].join("\n"),
    );
  });

  it("接続文字列の値がリテラルをまたいで続くときは続きの先頭も伏せる", () => {
    const vb = [
      'cs = "Server=x;Password=Hun" & "ter2Secret;Database=y"',
      'cs = "Server=x;Password=" & "Hun" & _',
      '    "ter2;Database=y"',
      'cs = "Server=x;Password=" & ";Database=y"',
    ].join("\n");
    assert.strictEqual(
      maskCredentials(vb, LOOSE_VB).content,
      [
        'cs = "Server=x;Password=[MASKED]" & "[MASKED];Database=y"',
        'cs = "Server=x;Password=" & "[MASKED]" & _',
        '    "[MASKED];Database=y"',
        'cs = "Server=x;Password=" & ";Database=y"',
      ].join("\n"),
    );
    // 汎用テキストとして伏せるときも、閉じた引用符の後の連結を値と取り違えない
    const split = 'cs = "Server=x;Password=" & _\n    "Hunter2;Pooling=true"';
    assert.strictEqual(maskCredentials(split, { vbSource: false, strict: false }).content, split);
    // SQL の条件は続きとみなさない(; の後のキーでない)
    const sql = ['sql = "SELECT * FROM t WHERE pwd=1" & " AND a=2"', 'sql = "WHERE pwd=" & "\'x\'" & " AND a=2"'].join("\n");
    assert.strictEqual(
      maskCredentials(sql, LOOSE_VB).content,
      ['sql = "SELECT * FROM t WHERE pwd=[MASKED]" & " AND a=2"', 'sql = "WHERE pwd=" & "[MASKED]" & " AND a=2"'].join("\n"),
    );
    const quoteOnly = 'sql = "UPDATE Users SET Password=" & _\n    "\'" & newPwd & "\'"';
    assert.strictEqual(maskCredentials(quoteOnly, LOOSE_VB).content, quoteOnly);
    const message = ['msg = "Password=" & vbCrLf & "Please enter"', 'strSQL &= " AND PASSWORD = " & "\'" & txt.Text & "\'"'].join("\n");
    assert.strictEqual(maskCredentials(message, LOOSE_VB).content, message);
  });
});

describe("credentialMasker: 汎用シークレット形式", () => {
  it("AWS アクセスキーをマスクする", () => {
    const result = maskCredentials("key = AKIAIOSFODNN7EXAMPLE", GENERIC);
    assert.ok(!result.content.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(result.content.includes("[MASKED]"));
  });

  it("GitHub トークンをマスクする", () => {
    const result = maskCredentials(
      "url = https://ghp_abcdefghijklmnopqrstuvwxyz123456@github.com",
      GENERIC,
    );
    assert.ok(!result.content.includes("ghp_abcdefghijk"));
  });

  it("Bearer トークンはトークン部のみマスクする", () => {
    const result = maskCredentials(
      "Authorization: Bearer abcdef1234567890TOKEN",
      GENERIC,
    );
    assert.ok(/Bearer \[MASKED\]/.test(result.content));
  });

  it("PRIVATE KEY ブロックは BEGIN/END を残して中身をマスクする", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1234567890",
      "abcdefghijklmnop",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = maskCredentials(pem, GENERIC);
    assert.ok(result.content.includes("-----BEGIN RSA PRIVATE KEY-----"));
    assert.ok(result.content.includes("-----END RSA PRIVATE KEY-----"));
    assert.ok(!result.content.includes("MIIEpAIBA"));
    assert.strictEqual(result.findings[0]?.kind, "秘密鍵");
  });

  it("コメントアウトされた認証情報コードもマスクする(実例由来)", () => {
    const code = [
      "'Case \"3\"",
      "'    wk_Bics_Pswd = \"komori\"",
      "'    In_Label.Text = \"BICS 本番環境(ツバゴ)\"",
    ].join("\n");
    const result = maskCredentials(code, VB);
    assert.ok(!result.content.includes("komori"));
    assert.ok(result.content.includes('wk_Bics_Pswd = "[MASKED]"'));
    // 認証と無関係なコメント行は触らない
    assert.ok(result.content.includes('In_Label.Text = "BICS 本番環境(ツバゴ)"'));
  });

  it("行番号が findings に記録される", () => {
    const code = ['Dim a As String = "x"', 'wk_Pswd = "secret1"'].join("\n");
    const result = maskCredentials(code, VB);
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.findings[0]?.line, 2);
  });
});

describe("credentialMasker: 日本語識別子・日本語キー", () => {
  it("日本語の秘密系変数への代入をマスクする", () => {
    const result = maskCredentials('パスワード = "himitsu123"', VB);
    assert.strictEqual(result.content, 'パスワード = "[MASKED]"');
    assert.strictEqual(result.findings[0]?.kind, "パスワード");
  });

  it("複合語の日本語変数(接続パスワード等)もマスクする", () => {
    const result = maskCredentials(
      'Public 接続パスワード As String = "abc"',
      VB,
    );
    assert.strictEqual(
      result.content,
      'Public 接続パスワード As String = "[MASKED]"',
    );
  });

  it("日本語のユーザー系変数への代入をマスクする", () => {
    const result = maskCredentials('ログインユーザ名 = "yamada"', VB);
    assert.strictEqual(result.content, 'ログインユーザ名 = "[MASKED]"');
    assert.strictEqual(result.findings[0]?.kind, "ユーザーID");
  });

  it("リテラル内の日本語キー=値をマスクする(半角カナ含む)", () => {
    const result = maskCredentials(
      'wk = "ﾊﾟｽﾜｰﾄﾞ=abc123;ユーザーID=yamada;"',
      VB,
    );
    assert.ok(result.content.includes("ﾊﾟｽﾜｰﾄﾞ=[MASKED];"));
    assert.ok(result.content.includes("ユーザーID=[MASKED];"));
  });

  it("設定ファイルの日本語キー(全角=・属性形式)をマスクする", () => {
    const text = ['パスワード=abc123', '<設定 パスワード="p@ss" />'].join("\n");
    const result = maskCredentials(text, GENERIC);
    assert.ok(!result.content.includes("abc123"));
    assert.ok(!result.content.includes("p@ss"));
    assert.ok(result.content.includes('パスワード="[MASKED]"'));
  });

  it("UI 文言(=を伴わない日本語)は触らない", () => {
    const code = [
      'Label1.Text = "パスワードを入力してください"',
      'Msg = "ユーザー名または暗証番号が違います"',
      'Title.Text = "パスワード: 8文字以上"',
    ].join("\n");
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });
});

describe("credentialMasker: メソッド引数", () => {
  it("秘密系メソッドの引数リテラルをマスクする", () => {
    const result = maskCredentials('Login("admin", "pass123")', VB);
    assert.strictEqual(result.content, 'Login("[MASKED]", "[MASKED]")');
    assert.strictEqual(result.findings.length, 2);
  });

  it("名前付き引数(password:=)をマスクする", () => {
    const result = maskCredentials(
      'Connect(server, password:="secret1", timeout:=30)',
      VB,
    );
    assert.strictEqual(
      result.content,
      'Connect(server, password:="[MASKED]", timeout:=30)',
    );
  });

  it("メンバー経由の呼び出し(auth.SetPassword)もマスクする", () => {
    const result = maskCredentials('auth.SetPassword("abc")', VB);
    assert.strictEqual(result.content, 'auth.SetPassword("[MASKED]")');
  });

  it("無関係なメソッドの引数は触らない", () => {
    const code = [
      'MsgBox("パスワードを入力")',
      'wk_Row("UNIT_ID") = ""',
      'Format(dt, "yyyy/MM/dd")',
    ].join("\n");
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });

  it("閉じた括弧の後(引数外)は触らない", () => {
    const code = '.Columns(0).Label = "ﾕﾆｯﾄｺｰﾄﾞ"';
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });
});

describe("credentialMasker: 高エントロピー値(厳格モード)", () => {
  it("リテラル内のランダム英数字列を既定でマスクする", () => {
    const result = maskCredentials(
      'Dim k As String = "x9Kp2mQ7vR4tW8nZ3cJ6bL1s"',
      VB,
    );
    assert.ok(!result.content.includes("x9Kp2mQ7"));
    assert.strictEqual(result.findings[0]?.kind, "高エントロピー値");
  });

  it("設定ファイル内の base64 らしき値もマスクする", () => {
    const result = maskCredentials(
      "<value>QWxhZGRpbjra29wZW4gc2Vz4W1l</value>",
      GENERIC,
    );
    assert.ok(!result.content.includes("QWxhZGRpb"));
  });

  it("GUID・普通の語・日本語文はマスクしない", () => {
    const code = [
      'Dim g As String = "{8A5B1234-C81C-45F6-A57F-5ABD9991F28F}"',
      'Dim s As String = "Windows10Update2026Info"',
      'Dim path As String = "C:\\Program Files\\MyApp2026\\bin"',
    ].join("\n");
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });

  it("識別子・コード構造は触らない(リテラル外は対象外)", () => {
    const code = "Dim wk_NBOM_2026_TotalCount1x9K As Integer = 0";
    assert.strictEqual(maskCredentials(code, VB).content, code);
  });

  it("strict: false で高エントロピーマスクだけ無効化できる", () => {
    const code = 'Dim k As String = "x9Kp2mQ7vR4tW8nZ3cJ6bL1s"';
    const result = maskCredentials(code, { vbSource: true, strict: false });
    assert.strictEqual(result.content, code);
    // 変数名ヒントによるマスクは strict: false でも生きている
    const withHint = maskCredentials(
      'wk_Pswd = "abc"',
      { vbSource: true, strict: false },
    );
    assert.strictEqual(withHint.content, 'wk_Pswd = "[MASKED]"');
  });
});

describe("credentialMasker: 一部だけ伏せたトークンの残り(厳格モード)", () => {
  it("Bearer トークンの「.」の後ろの短い部分も伏せる", () => {
    const vb = 'req.Headers.Add("Authorization", "Bearer Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8.sEcReTtAiLvAlUe")';
    const result = maskCredentials(vb, VB);
    assert.ok(!result.content.includes("sEcReTtAiLvAlUe"), result.content);
    assert.ok(result.content.includes('"Bearer [MASKED]"'));
  });

  it("JWT の 20 文字未満の部分も伏せる", () => {
    const jwt = "token: eyJhbGciOiJub25lIn0.eyJ1c2VyIjoiYWRtaW4iLCJyb2xlIjoiYWRtaW4ifQ.abcdefghijklmnop";
    const result = maskCredentials(jwt, GENERIC);
    assert.strictEqual(result.content, "token: [MASKED]");
  });

  it("すべて伏せた部分だけなら変えない", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    assert.strictEqual(maskCredentials(jwt, GENERIC).content, "[MASKED].[MASKED].[MASKED]");
    assert.strictEqual(maskCredentials("Use Bearer [MASKED].", GENERIC).content, "Use Bearer [MASKED].");
  });

  it("JWT の形でないドット区切りの語は伏せすぎない", () => {
    const url = "https://k7Qx9Pz2Lm4Vb8Nc3Rt.execute-api.ap-northeast-1.amazonaws.com";
    assert.strictEqual(
      maskCredentials(url, { ...GENERIC, strict: true }).content,
      "https:[MASKED].execute-api.ap-northeast-1.amazonaws.com",
    );
    assert.strictEqual(
      maskCredentials("AKIAIOSFODNN7EXAMPLE.something.whatever", GENERIC).content,
      "[MASKED].something.whatever",
    );
    assert.strictEqual(maskCredentials("x = [MASKED].Resource1.Designer", GENERIC).content, "x = [MASKED].Resource1.Designer");
    // 高エントロピーのサブドメインを 2 つ伏せたホスト名は、残りを伏せない(JWT は 3 つに区切られる)
    assert.strictEqual(
      maskCredentials("Server=tcp:Xk3pQ9vLm2Rt7sWz8Yb4.Hq5nJ8cV1xKz6Tg3Lp0W.database.windows.net;", { ...GENERIC, strict: true })
        .content,
      "Server=tcp:[MASKED].[MASKED].database.windows.net;",
    );
    assert.strictEqual(
      maskCredentials("Server=tcp:Xk3pQ9vLm2Rt7sWz8Yb4.Hq5nJ8cV1xKz6Tg3Lp0W.internal,1433;", { ...GENERIC, strict: true }).content,
      "Server=tcp:[MASKED].[MASKED].internal,1433;",
    );
    // 署名が文字列の連結で途中で切れているときは、短い残りも伏せる
    assert.strictEqual(
      maskCredentials('t = "[MASKED].[MASKED].SflKxwRJSMeKKF2" & _', GENERIC).content,
      't = "[MASKED]" & _',
    );
    // 連結が続いても、小文字・数字・- だけの残りはホスト名のラベルなので伏せない
    assert.strictEqual(
      maskCredentials('"Server=tcp:Xk3pQ9vLm2Rt7sWz8Yb4.Hq5nJ8cV1xKz6Tg3Lp0W.internal" & ";Database=App"', {
        ...GENERIC,
        strict: true,
      }).content,
      '"Server=tcp:[MASKED].[MASKED].internal" & ";Database=App"',
    );
    // 残りが署名のように長ければは (URL の末尾の拡張子が続いても) 伏せる
    assert.strictEqual(
      maskCredentials("cb/[MASKED].[MASKED].aaaaaaaaaabbbbbbbbbbcccccccccc.json", GENERIC).content,
      "cb/[MASKED].json",
    );
  });
});
