/**
 * .gitignore のパターン照合(git の gitignore(5) の規則)。
 *
 * 実行時依存ゼロのため ignore パッケージの代わりに自前で持つ(設計書 §25.3-3)。
 * 対応する書き方: 否定 `!`、末尾 `/`(ディレクトリだけ)、先頭・途中の `/`(.gitignore の場所からの相対)、
 * `**`(先頭の `**\/`・途中の `/**\/`・末尾の `/**`)、`*`、`?`、文字クラス `[...]`(`!` / `^` の否定・範囲・
 * `[:alpha:]` などの名前つきクラス)、`\` のエスケープ、`#` のコメント、末尾の空白(`\ ` は残す)。
 * 大文字と小文字は既定で区別しない(Windows の git の core.ignorecase と同じ)。
 *
 * 照合はパスの親ディレクトリから順に行い、親が無視されていればその中は否定パターンでも戻さない
 * (git の「親ディレクトリを除外したら中のファイルは再び含められない」)。
 * テストでは同じパターンを `git check-ignore` にもかけて結果が一致することを確かめる。
 */

export interface IgnoreVerdict {
  /** 無視される(最後に一致したパターンが否定でない) */
  ignored: boolean;
  /** 否定パターンで戻された(最後に一致したパターンが否定) */
  unignored: boolean;
}

interface Rule {
  negative: boolean;
  /** 末尾が `/` のパターン(ディレクトリにだけ一致する) */
  dirOnly: boolean;
  /** `/` を含むパターン(.gitignore の場所からの相対パス全体と照合する)。含まなければ名前だけと照合する */
  anchored: boolean;
  regex: RegExp;
}

const NOT_IGNORED: IgnoreVerdict = { ignored: false, unignored: false };

/** 名前つきの文字クラス(POSIX)。`/` は含まない */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "!-.0-~",
  lower: "a-z",
  print: " -.0-~",
  punct: "!-.:-@\\[-`{-~",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
};

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * 文字クラス `[...]` を正規表現に直す。pattern[start] は `[`。
 * 閉じていなければ undefined(git では `[` をふつうの文字として扱う)
 */
function compileBracket(pattern: string, start: number): { source: string; end: number } | undefined {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i += 1;
  }
  let body = "";
  let first = true;
  for (; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "]" && !first) {
      // `/` には一致しない(パスの区切りをまたがない)
      return { source: negate ? `[^/${body}]` : `(?!/)[${body}]`, end: i + 1 };
    }
    first = false;
    if (ch === "[" && pattern[i + 1] === ":") {
      const close = pattern.indexOf(":]", i + 2);
      const name = close < 0 ? undefined : pattern.slice(i + 2, close);
      const cls = name === undefined ? undefined : POSIX_CLASSES[name];
      if (cls !== undefined && close >= 0) {
        body += cls;
        i = close + 1;
        continue;
      }
      // 知らない名前のクラスは文字クラス全体を無効にする(git と同じく一致しない)
      if (name !== undefined && close >= 0) {
        return { source: "(?!)", end: close + 2 };
      }
    }
    let literal = ch;
    if (ch === "\\" && i + 1 < pattern.length) {
      i += 1;
      literal = pattern.charAt(i);
    }
    // 範囲 a-z(後ろが `]` なら `-` はふつうの文字)
    if (pattern[i + 1] === "-" && i + 2 < pattern.length && pattern[i + 2] !== "]") {
      let to = pattern.charAt(i + 2);
      let next = i + 2;
      if (to === "\\" && i + 3 < pattern.length) {
        to = pattern.charAt(i + 3);
        next = i + 3;
      }
      // 逆順の範囲は何にも一致しない(git の wildmatch と同じ)
      if (to.codePointAt(0)! >= literal.codePointAt(0)!) {
        body += `${escapeRegExpChar(literal)}-${escapeRegExpChar(to)}`;
      }
      i = next;
      continue;
    }
    body += escapeRegExpChar(literal);
  }
  return undefined;
}

/**
 * グロブ(先頭の `/` と末尾の `/` は外したもの)を正規表現の本体にする。
 * anchored(パス全体と照合する)なら、git と同じく先頭のワイルドカードのない部分の直後の `**` も
 * 区切りの直後とみなす(git はその部分を先に比べて外してから照合するため、`ab**\/c` は `ab` + `**\/c`)
 */
function compileGlob(glob: string, anchored: boolean): string {
  let out = "";
  let i = 0;
  const literalPrefix = anchored ? glob.search(/[*?[\\]/) : -1;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      let j = i;
      while (glob[j] === "*") j += 1;
      const stars = j - i;
      const atSegmentStart = i === 0 || glob[i - 1] === "/" || i === literalPrefix;
      const atSegmentEnd = j === glob.length || glob[j] === "/";
      if (stars >= 2 && atSegmentStart && atSegmentEnd) {
        if (j === glob.length) {
          // 末尾の `**`(`a/**` は a の中のすべて。照合するパスは `/` で終わらないので空も許してよい)
          out += ".*";
          i = j;
        } else {
          // `**/`(0 個以上のディレクトリ)
          out += "(?:.*/)?";
          i = j + 1;
        }
        continue;
      }
      out += "[^/]*";
      i = j;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const bracket = compileBracket(glob, i);
      if (bracket !== undefined) {
        out += bracket.source;
        i = bracket.end;
        continue;
      }
      out += "\\[";
      i += 1;
      continue;
    }
    if (ch === "\\") {
      // 末尾の `\` だけのパターンは無効(parseRule で除く)
      out += escapeRegExpChar(glob.charAt(i + 1));
      i += 2;
      continue;
    }
    out += escapeRegExpChar(ch);
    i += 1;
  }
  return out;
}

/** 末尾の空白を落とす(`\ ` のようにエスケープした空白は残す) */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    // 直前の `\` の数が奇数ならこの空白はエスケープされている
    let backslashes = 0;
    for (let k = end - 2; k >= 0 && line[k] === "\\"; k--) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function parseRule(rawLine: string, ignoreCase: boolean): Rule | undefined {
  let line = trimTrailingSpaces(rawLine);
  if (line === "" || line.startsWith("#")) return undefined;
  let negative = false;
  if (line.startsWith("!")) {
    negative = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  // 末尾が奇数個の `\` のパターンは git では何にも一致しない
  const trailing = /\\+$/.exec(line)?.[0].length ?? 0;
  if (trailing % 2 === 1) return undefined;
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return undefined;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  if (line === "") return undefined;
  return {
    negative,
    dirOnly,
    anchored,
    regex: new RegExp(`^${compileGlob(line, anchored)}$`, ignoreCase ? "i" : ""),
  };
}

/** 1 つの .gitignore(を連結したもの)の規則 */
export class GitignoreRules {
  private readonly rules: Rule[] = [];
  private readonly cache = new Map<string, IgnoreVerdict>();
  private readonly ignoreCase: boolean;

  constructor(text = "", ignoreCase = true) {
    this.ignoreCase = ignoreCase;
    this.add(text);
  }

  /** 規則を足す(後に足したものが優先) */
  add(text: string): this {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    for (const line of lines) {
      const rule = parseRule(line, this.ignoreCase);
      if (rule !== undefined) this.rules.push(rule);
    }
    this.cache.clear();
    return this;
  }

  /**
   * .gitignore の場所からの相対パス(`/` 区切り。ファイルとして扱う)の判定。
   * 親ディレクトリが無視されていれば、その結果を返す
   */
  test(relativePath: string): IgnoreVerdict {
    const segments = relativePath.split("/").filter((s) => s !== "");
    if (segments.length === 0) return NOT_IGNORED;
    for (let i = 1; i < segments.length; i++) {
      const verdict = this.testOne(segments.slice(0, i), true);
      if (verdict.ignored) return verdict;
    }
    return this.testOne(segments, false);
  }

  ignores(relativePath: string): boolean {
    return this.test(relativePath).ignored;
  }

  private testOne(segments: string[], isDirectory: boolean): IgnoreVerdict {
    const full = segments.join("/");
    const key = `${isDirectory ? "d" : "f"}:${full}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const name = segments[segments.length - 1] ?? "";
    let verdict = NOT_IGNORED;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(rule.anchored ? full : name)) {
        verdict = { ignored: !rule.negative, unignored: rule.negative };
      }
    }
    this.cache.set(key, verdict);
    return verdict;
  }
}
