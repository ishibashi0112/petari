import { describe, expect, it } from "vitest";
import { maskCredentials, maskLinesForDisplay, maskedViews } from "../src/core/mask.ts";
import { literalRegions, sourceLanguageOf, type SourceLanguage } from "../src/core/source-lexer.ts";

const mask = (text: string, language: SourceLanguage, strict = true): string =>
  maskCredentials(text, { vbSource: false, strict, language }).content;
const generic = (text: string, strict = true): string => maskCredentials(text, { vbSource: false, strict }).content;

describe("言語ごとの伏せ方 (設計書 §25.7)", () => {
  it("拡張子から言語を決める (対応しない拡張子は汎用テキスト)", () => {
    expect(sourceLanguageOf("src/a.ts")).toBe("js");
    expect(sourceLanguageOf("src/a.TSX")).toBe("js");
    expect(sourceLanguageOf("App/Main.java")).toBe("java");
    expect(sourceLanguageOf("x\\Program.cs")).toBe("csharp");
    expect(sourceLanguageOf("main.go")).toBe("go");
    expect(sourceLanguageOf("app.py")).toBe("python");
    expect(sourceLanguageOf("Module1.vb")).toBeUndefined();
    expect(sourceLanguageOf("App.config")).toBeUndefined();
    expect(sourceLanguageOf("Makefile")).toBeUndefined();
  });

  it("TS: コードの式は伏せず、文字列・コメントの中は伏せる", () => {
    const source = [
      "const apiKey = process.env.API_KEY;",
      'const password = "hunter2xyz";',
      "const token = getToken(user.password);",
      "if (password === pass) { return true; }",
      'const conn = "Server=db;User Id=sa;Password=P@ssw0rd!;";',
      'const secret = config.get("secret");',
      "this.password = password;",
      "// password = oldSecret123",
    ].join("\n");
    expect(mask(source, "js").split("\n")).toEqual([
      "const apiKey = process.env.API_KEY;",
      'const password = "[MASKED]";',
      "const token = getToken(user.password);",
      "if (password === pass) { return true; }",
      'const conn = "Server=db;User Id=[MASKED];Password=[MASKED];";',
      'const secret = config.get("secret");',
      "this.password = password;",
      "// password = [MASKED]",
    ]);
  });

  it("Python / C# / Java / Go の代表的な形", () => {
    expect(mask('password = os.environ["DB_PASSWORD"]\napi_key = "sk_live_abcdefghijklmnop1234"\n', "python")).toBe(
      'password = os.environ["DB_PASSWORD"]\napi_key = "[MASKED]"\n',
    );
    expect(mask('var password = ConfigurationManager.AppSettings["Password"];\nconst string Password = "P@ssw0rd!";', "csharp")).toBe(
      'var password = ConfigurationManager.AppSettings["Password"];\nconst string Password = "[MASKED]";',
    );
    expect(mask('String password = System.getenv("DB_PASSWORD");\nString apiKey = "abcd1234efgh5678ijkl";', "java")).toBe(
      'String password = System.getenv("DB_PASSWORD");\nString apiKey = "[MASKED]";',
    );
    expect(mask('password := os.Getenv("DB_PASSWORD")\napiKey := "AKIAIOSFODNN7EXAMPLE"', "go")).toBe(
      'password := os.Getenv("DB_PASSWORD")\napiKey := "[MASKED]"',
    );
  });

  it("閉じていない文字列のある行は全体をリテラルとみなす (読み違えで値を出さない)", () => {
    // 正規表現を割り算と読み違えると ' が文字列の始まりに見える。行末で閉じないので行全体を伏せたままにする
    const source = "x = a / b; const re = /'/; password = hunter2secret;";
    expect(literalRegions(source, "js").uncertainLines.has(0)).toBe(false);
    const broken = "password = 'hunter2secret";
    expect(mask(broken, "js")).toBe(generic(broken));
  });

  it("C# の逐語的・補間・生文字列、Python の三重引用符・f 文字列、Go の生文字列をリテラルとして読む", () => {
    const cs = 'var a = @"C:\\dir\\" + x;\nvar b = $"{(f ? "p" : "q")} password=abc123secret";\nvar c = """\npassword=rawSecret123\n""";';
    const regions = literalRegions(cs, "csharp").regions.map(([s, e]) => cs.slice(s, e));
    expect(regions).toContain("C:\\dir\\");
    expect(regions.some((r) => r.includes("password=abc123secret"))).toBe(true);
    expect(regions.some((r) => r.includes("password=rawSecret123"))).toBe(true);
    const py = 'x = f"{d["k"]} password=abc123secret"\ny = """\npassword=tripleSecret1\n"""\n';
    expect(mask(py, "python")).not.toContain("abc123secret");
    expect(mask(py, "python")).not.toContain("tripleSecret1");
    const go = "s := `\npassword=goRawSecret1\n`";
    expect(mask(go, "go")).not.toContain("goRawSecret1");
  });

  it("秘密鍵のブロックは汎用テキストと同じく 3 行にまとめる", () => {
    const key = "const k = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx\nabc\n-----END RSA PRIVATE KEY-----`;";
    expect(mask(key, "js")).toBe(generic(key));
  });

  it("抜粋の伏せ方 (失敗レポート) は汎用テキストの範囲も含める (旧 slnmix のパックから写した SEARCH 用)", () => {
    const lines = ["const apiKey = process.env.API_KEY;", 'const password = "hunter2xyz";'];
    expect(maskLinesForDisplay(lines, { path: "a.ts" })).toEqual(["const apiKey = [MASKED];", 'const password = "[MASKED]";']);
    // 照合用の表示には言語ごとの伏せ方のものも入る
    const views = maskedViews(lines, "a.ts").map((view) => view.map((line) => line.text));
    expect(views).toContainEqual(["const apiKey = process.env.API_KEY;", 'const password = "[MASKED]";']);
  });
});

// ---------------------------------------------------------------------------
// ランダムに組んだソースで、汎用テキストとして伏せる値を言語ごとの伏せ方でも伏せることを確かめる
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 文の型。$ は秘密の値の差し込み位置 */
const STATEMENTS: Readonly<Record<SourceLanguage, readonly string[]>> = {
  js: [
    'const password = "$";',
    "let apiKey = '$';",
    "const secret = `$`;",
    "const token = `pre-${a}-$`;",
    "// password = $",
    "/* token: $ */",
    "/*\n password = $\n*/",
    'const conn = "Server=x;Password=$;";',
    'obj = { password: "$" };',
    "const cfg = `\npassword=$\n`;",
    'fetch(url, { headers: { Authorization: "Bearer $" } });',
    "this.password = password;",
    "const k = process.env.API_KEY;",
    "if (a === b) { return c / d; }",
    "const re = /a\\/b[/]c'/g;",
    "x = a / b / c;",
    'const s = "a\\"b // not comment";',
    "const t = 'it\\'s /* not */';",
    "const n = `${`nested ${x}`}`;",
    "return /=\"/.test(v);",
    "<div title=\"it's\">it's</div>",
  ],
  java: [
    'String password = "$";',
    "char c = '\\'';",
    "// password = $",
    "/* secret = $ */",
    'String block = """\n  password=$\n  """;',
    'String conn = "jdbc:x;password=$;";',
    "this.password = password;",
    'String p = System.getenv("DB_PASSWORD");',
    'String s = "a\\"b // not";',
  ],
  csharp: [
    'var password = "$";',
    'var path = @"C:\\x\\" + y;',
    'var v = @"line ""q"" password=$";',
    'var i = $"{(f ? "p" : "q")} password=$";',
    'var r = """\npassword=$\n""";',
    "char c = '\\'';",
    "// password = $",
    "/* secret = $ */",
    'var conn = "Server=x;Password=$;";',
    "user.Password = model.Password;",
    'var p = ConfigurationManager.AppSettings["Password"];',
  ],
  go: [
    'password := "$"',
    "s := `\npassword=$\n`",
    "r := '\\''",
    "// password = $",
    "/* token: $ */",
    'dsn := "user:$@tcp(db)/x"',
    "secret := cfg.Secret",
    "db.Password = input.Password",
    'p := os.Getenv("DB_PASSWORD")',
  ],
  python: [
    'password = "$"',
    "api_key = '$'",
    "# password = $",
    'doc = """\npassword=$\n"""',
    "x = f\"{d['k']} password=$\"",
    'y = rb"\\d password=$"',
    "conn = 'Server=x;Password=$;'",
    "self.password = password",
    'p = os.environ["DB_PASSWORD"]',
    "s = 'it\\'s # not comment'",
    "z = 'a' \\\n  + 'b'",
  ],
};

describe("言語ごとの伏せ方: ランダムに組んだソースで値を出さない", () => {
  for (const language of Object.keys(STATEMENTS) as SourceLanguage[]) {
    it(`${language}: 汎用テキストとして伏せる値は、言語ごとの伏せ方でも伏せる`, () => {
      const rand = mulberry32(language.length * 7919);
      const statements = STATEMENTS[language];
      let reduced = 0;
      for (let round = 0; round < 400; round++) {
        const values: string[] = [];
        const lines: string[] = [];
        const count = 2 + Math.floor(rand() * 10);
        for (let k = 0; k < count; k++) {
          let statement = statements[Math.floor(rand() * statements.length)] ?? "";
          while (statement.includes("$") && !statement.includes("${")) {
            let value = "";
            for (let c = 0; c < 10 + Math.floor(rand() * 10); c++) value += ALNUM[Math.floor(rand() * ALNUM.length)];
            values.push(value);
            statement = statement.replace("$", value);
          }
          if (statement.includes("${") && statement.includes("-$")) {
            let value = "";
            for (let c = 0; c < 14; c++) value += ALNUM[Math.floor(rand() * ALNUM.length)];
            values.push(value);
            statement = statement.replace("-$", `-${value}`);
          }
          lines.push(statement);
        }
        const source = lines.join(rand() < 0.5 ? "\n" : "\r\n");
        for (const strict of [true, false]) {
          const before = generic(source, strict);
          const after = mask(source, language, strict);
          for (const value of values) {
            if (!before.includes(value)) {
              expect(after, `${language} の値 ${value} が出ている:\n${source}\n---\n${after}`).not.toContain(value);
            }
          }
          const count = (text: string): number => text.split("[MASKED]").length;
          if (count(after) < count(before)) reduced += 1;
        }
      }
      // コードを伏せなくなった分、伏せ字は減る
      expect(reduced).toBeGreaterThan(0);
    });
  }
});
