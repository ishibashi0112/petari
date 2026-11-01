/**
 * ソースコードの「リテラル (文字列・コメント・数値)」の範囲を求める簡易字句解析 (設計書 §25.7 の言語ごとの伏せ方)。
 *
 * 汎用テキストとしての伏せ方は `key = value` の形を行の終わりまで見るため、コードでは
 * `const apiKey = process.env.API_KEY;` の `process.env.API_KEY` のような式まで伏せてしまう。
 * 言語の分かるファイルでは、伏せた範囲のうちリテラルの中の部分だけを伏せたままにし、
 * コードの部分は戻す (mask.ts の maskCredentials)。そのためにリテラルの範囲を求める。
 *
 * 安全側の決まり (読み違えたときに、伏せるべき値をコードと見なさない):
 * - 1 行で閉じるはずの文字列が行末で閉じていなければ、その行は全体をリテラルとみなす
 *   (uncertainLines。読み違えのほとんどはここに出る)
 * - 複数行にまたがるもの (ブロックコメント・テンプレート文字列・三重引用符など) が
 *   閉じなければ、ファイルの終わりまでリテラル
 * - テンプレート文字列・f 文字列・補間文字列は、埋め込みの式も含めて全体をリテラルとみなす
 *   (式の中の文字列で終わりを見失わないよう、式は入れ子で読む)
 *
 * I/O を持たない純粋ロジック。
 */

export type SourceLanguage = "js" | "java" | "csharp" | "go" | "python";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SourceLanguage>> = {
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".ts": "js",
  ".tsx": "js",
  ".mts": "js",
  ".cts": "js",
  ".java": "java",
  ".cs": "csharp",
  ".go": "go",
  ".py": "python",
  ".pyw": "python",
  ".pyi": "python",
};

/** パスの拡張子から言語を決める (対応していなければ undefined = 汎用テキストとして伏せる) */
export function sourceLanguageOf(filePath: string): SourceLanguage | undefined {
  const match = /\.[^./\\]+$/.exec(filePath);
  return match === null ? undefined : LANGUAGE_BY_EXTENSION[match[0].toLowerCase()];
}

export interface LiteralRegions {
  /** リテラルの範囲 [start, end) (元の文字列の位置。昇順・重なりなし) */
  regions: Array<[number, number]>;
  /** 読み違えの恐れがあり、全体をリテラルとみなす行 (0 始まり) */
  uncertainLines: Set<number>;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;

/** 直前のトークンがこれなら、JS の `/` は正規表現の始まり (それ以外は割り算) */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

class Lexer {
  readonly regions: Array<[number, number]> = [];
  readonly uncertainLines = new Set<number>();
  private readonly lineStarts: number[] = [0];
  /** JS の正規表現の判定用: 直前の意味のあるトークン */
  private prev: { kind: "none" | "ident" | "number" | "literal" | "punct"; text: string } = {
    kind: "none",
    text: "",
  };

  private readonly text: string;
  private readonly language: SourceLanguage;

  constructor(text: string, language: SourceLanguage) {
    this.text = text;
    this.language = language;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  private lineOf(index: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** 範囲を記録する (入れ子の範囲と重なり得るので、まとめるのは最後に literalRegions で) */
  private add(start: number, end: number): void {
    if (end > start) this.regions.push([start, end]);
  }

  private uncertain(index: number): void {
    this.uncertainLines.add(this.lineOf(index));
  }

  private startsWith(s: string, i: number): boolean {
    return this.text.startsWith(s, i);
  }

  /**
   * コードを読む。untilBrace なら、対応する `}` の位置で止まってその位置を返す
   * (補間・テンプレートの式の中)。そうでなければ終わりまで読んで text.length を返す
   */
  code(start: number, untilBrace: boolean): number {
    const t = this.text;
    let i = start;
    let depth = 0;
    while (i < t.length) {
      const c = t.charAt(i);
      if (c === "\n" || c === " " || c === "\t" || c === "\r") {
        i += 1;
        continue;
      }
      if (untilBrace) {
        if (c === "{") {
          depth += 1;
          this.prev = { kind: "punct", text: c };
          i += 1;
          continue;
        }
        if (c === "}") {
          if (depth === 0) return i;
          depth -= 1;
          this.prev = { kind: "punct", text: c };
          i += 1;
          continue;
        }
      }
      const next = this.literal(i);
      if (next !== undefined) {
        i = next;
        continue;
      }
      if (DIGIT.test(c) && !(i > 0 && IDENT_CHAR.test(t.charAt(i - 1)))) {
        let j = i + 1;
        while (j < t.length && (/[0-9A-Za-z_.]/.test(t.charAt(j)) || (/[eEpP]/.test(t.charAt(j - 1)) && /[+-]/.test(t.charAt(j))))) {
          j += 1;
        }
        this.add(i, j);
        this.prev = { kind: "number", text: t.slice(i, j) };
        i = j;
        continue;
      }
      if (IDENT_CHAR.test(c)) {
        let j = i + 1;
        while (j < t.length && IDENT_CHAR.test(t.charAt(j))) j += 1;
        this.prev = { kind: "ident", text: t.slice(i, j) };
        i = j;
        continue;
      }
      this.prev = { kind: "punct", text: c };
      i += 1;
    }
    return t.length;
  }

  /** i からコメント・文字列・正規表現が始まるなら、その終わりの位置。始まらなければ undefined */
  private literal(i: number): number | undefined {
    const t = this.text;
    const c = t.charAt(i);
    const lang = this.language;
    if (lang === "python") {
      if (c === "#") return this.lineComment(i);
      const prefixed = /^([rRbBuUfF]{1,2})?('''|"""|'|")/.exec(t.slice(i, i + 5));
      if (prefixed !== null && !(prefixed[1] !== undefined && i > 0 && IDENT_CHAR.test(t.charAt(i - 1)))) {
        const prefix = prefixed[1] ?? "";
        const quote = prefixed[2] ?? '"';
        const end = this.pythonString(i + prefix.length, quote, /[fF]/.test(prefix));
        this.prev = { kind: "literal", text: "" };
        return end;
      }
      return undefined;
    }
    if (c === "/" && t.charAt(i + 1) === "/") return this.lineComment(i);
    if (c === "/" && t.charAt(i + 1) === "*") {
      const close = t.indexOf("*/", i + 2);
      const end = close < 0 ? t.length : close + 2;
      this.add(i, end);
      return end;
    }
    let end: number | undefined;
    if (lang === "js") {
      if (c === '"' || c === "'") end = this.singleLineString(i, c);
      else if (c === "`") end = this.template(i);
      else if (c === "/" && this.regexAllowed()) end = this.regex(i);
    } else if (lang === "java") {
      if (this.startsWith('"""', i)) end = this.delimited(i, 3, '"""', true);
      else if (c === '"' || c === "'") end = this.singleLineString(i, c);
    } else if (lang === "go") {
      if (c === "`") end = this.delimited(i, 1, "`", false);
      else if (c === '"' || c === "'") end = this.singleLineString(i, c);
    } else if (lang === "csharp") {
      end = this.csharpString(i);
    }
    if (end !== undefined) this.prev = { kind: "literal", text: "" };
    return end;
  }

  private lineComment(i: number): number {
    const newline = this.text.indexOf("\n", i);
    const end = newline < 0 ? this.text.length : newline;
    this.add(i, end);
    return end;
  }

  /**
   * 1 行で閉じる文字列 ("..." / '...')。バックスラッシュでエスケープ、バックスラッシュ + 改行は続き。
   * 行末で閉じなければ、その行を読み違えの恐れありとする
   */
  private singleLineString(i: number, quote: string): number {
    const t = this.text;
    let j = i + 1;
    while (j < t.length) {
      const c = t.charAt(j);
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === quote) {
        this.add(i + 1, j);
        return j + 1;
      }
      if (c === "\n") break;
      j += 1;
    }
    // 閉じていない: 行の終わりまでをリテラルにし、行全体を安全側に倒す
    const end = Math.min(j, t.length);
    this.add(i + 1, end);
    this.uncertain(i);
    return end;
  }

  /** 開始の区切り (長さ openLength) から close までをリテラルにする (閉じなければ終わりまで) */
  private delimited(i: number, openLength: number, close: string, escapes: boolean): number {
    const t = this.text;
    let j = i + openLength;
    while (j < t.length) {
      if (escapes && t.charAt(j) === "\\") {
        j += 2;
        continue;
      }
      if (t.startsWith(close, j)) {
        this.add(i + openLength, j);
        return j + close.length;
      }
      j += 1;
    }
    this.add(i + openLength, t.length);
    return t.length;
  }

  /** JS のテンプレート文字列。${...} の式は入れ子で読み、全体をリテラルにする */
  private template(i: number): number {
    const t = this.text;
    let j = i + 1;
    while (j < t.length) {
      const c = t.charAt(j);
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") {
        this.add(i + 1, j);
        return j + 1;
      }
      if (c === "$" && t.charAt(j + 1) === "{") {
        j = this.embedded(j + 2);
        continue;
      }
      j += 1;
    }
    this.add(i + 1, t.length);
    return t.length;
  }

  /** 補間の式 (`{` の次から) を読み、対応する `}` の次の位置を返す。式の中のリテラルも記録する */
  private embedded(start: number): number {
    const saved = this.prev;
    this.prev = { kind: "none", text: "" };
    const close = this.code(start, true);
    this.prev = saved;
    return Math.min(close + 1, this.text.length);
  }

  private regexAllowed(): boolean {
    const prev = this.prev;
    if (prev.kind === "none") return true;
    if (prev.kind === "ident") return REGEX_PRECEDING_KEYWORDS.has(prev.text);
    if (prev.kind === "number" || prev.kind === "literal") return false;
    return !/^[)\]}]$/.test(prev.text);
  }

  /** JS の正規表現リテラル (文字クラスの中の / は区切りではない)。行末で閉じなければ読み違えの恐れあり */
  private regex(i: number): number {
    const t = this.text;
    let j = i + 1;
    let inClass = false;
    while (j < t.length) {
      const c = t.charAt(j);
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "\n") break;
      if (inClass) {
        if (c === "]") inClass = false;
      } else if (c === "[") {
        inClass = true;
      } else if (c === "/") {
        let k = j + 1;
        while (k < t.length && /[A-Za-z]/.test(t.charAt(k))) k += 1;
        this.add(i + 1, j);
        return k;
      }
      j += 1;
    }
    const end = Math.min(j, t.length);
    this.add(i + 1, end);
    this.uncertain(i);
    return end;
  }

  /**
   * Python の文字列 (prefix の後ろの引用符の位置から)。三重引用符は複数行、それ以外は 1 行
   * (バックスラッシュ + 改行は続き)。f 文字列の {...} は入れ子で読む
   */
  private pythonString(i: number, quote: string, formatted: boolean): number {
    const t = this.text;
    const triple = quote.length === 3;
    let j = i + quote.length;
    while (j < t.length) {
      const c = t.charAt(j);
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (t.startsWith(quote, j)) {
        this.add(i + quote.length, j);
        return j + quote.length;
      }
      if (formatted && c === "{") {
        if (t.charAt(j + 1) === "{") {
          j += 2;
          continue;
        }
        j = this.embedded(j + 1);
        continue;
      }
      if (c === "\n" && !triple) break;
      j += 1;
    }
    const end = Math.min(j, t.length);
    this.add(i + quote.length, end);
    if (!triple) this.uncertain(i);
    return end;
  }

  /**
   * C# の文字列と文字: 生文字列 ("""...""" / $"""..."""。引用符の数で閉じる)、逐語的文字列 (@"..." / $@"..." /
   * @$"..."。"" がエスケープ、複数行)、通常の文字列 ("..." / $"...")、文字 ('x')。補間の {...} は入れ子で読む
   */
  private csharpString(i: number): number | undefined {
    const t = this.text;
    const head = /^(\$*)(@?)(\$*)("+)/.exec(t.slice(i, i + 64));
    const c = t.charAt(i);
    if (c === "'") return this.singleLineString(i, "'");
    if (head === null) return undefined;
    const dollars = (head[1] ?? "").length + (head[3] ?? "").length;
    const verbatim = head[2] === "@";
    const quotes = (head[4] ?? "").length;
    const open = head[0].length;
    if (quotes >= 3 && !verbatim) {
      // 生文字列: 同じ数の引用符で閉じる (補間の式も含めて全体をリテラルにする)
      const close = '"'.repeat(quotes);
      const end = t.indexOf(close, i + open);
      const stop = end < 0 ? t.length : end;
      this.add(i + open, stop);
      return end < 0 ? t.length : end + quotes;
    }
    if (quotes === 2 && !verbatim) {
      // 空の文字列 ""
      return i + open;
    }
    const interpolated = dollars > 0;
    const contentStart = i + open - (quotes - 1);
    let j = contentStart;
    while (j < t.length) {
      const ch = t.charAt(j);
      if (verbatim) {
        if (ch === '"') {
          if (t.charAt(j + 1) === '"') {
            j += 2;
            continue;
          }
          this.add(contentStart, j);
          return j + 1;
        }
      } else {
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === '"') {
          this.add(contentStart, j);
          return j + 1;
        }
        if (ch === "\n") break;
      }
      if (interpolated && ch === "{") {
        if (t.charAt(j + 1) === "{") {
          j += 2;
          continue;
        }
        j = this.embedded(j + 1);
        continue;
      }
      j += 1;
    }
    const end = Math.min(j, t.length);
    this.add(contentStart, end);
    if (!verbatim) this.uncertain(i);
    return end;
  }
}

/** ソースのリテラル (文字列の中身・コメント・数値) の範囲と、読み違えの恐れのある行を求める */
export function literalRegions(text: string, language: SourceLanguage): LiteralRegions {
  const lexer = new Lexer(text, language);
  lexer.code(0, false);
  lexer.regions.sort((a, b) => a[0] - b[0]);
  // 入れ子 (補間の式の中) で記録した範囲は外側の範囲に含まれるのでまとめる
  const merged: Array<[number, number]> = [];
  for (const [start, end] of lexer.regions) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { regions: merged, uncertainLines: lexer.uncertainLines };
}
