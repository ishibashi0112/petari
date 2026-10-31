/**
 * 認証情報の伏せ字 (§7 失敗レポート / 伏せ字の行の照合)。
 *
 * slnmix がパックを作るときに認証情報らしき値を [MASKED] に置き換えるため、AI の返答
 * (SEARCH / REPLACE / CONTENT) にも [MASKED] が入る。petari は次の 3 点でこれを扱う:
 * - 失敗レポートの「実ファイルの該当箇所」を伏せる (AI に貼るレポートから実際の値が漏れない)
 * - SEARCH の [MASKED] を「伏せた後の実ファイル」と照合する (伏せ字の行も変更できる)
 * - 書き込む行の [MASKED] を元の値に戻す。戻せなければ書かずに止める
 *
 * maskCredentials は slnmix の src/services/credentialMasker.ts の写し (slnmix 0.22.1 時点)。
 * 判定を変えるときは両方を揃える (slnmix と petari の統合で 1 つに戻す。設計書 §25)。
 * I/O を持たない純粋ロジック。
 */

export interface MaskFinding {
  /** 1 始まりの行番号(置換前テキスト基準の近似値) */
  line: number;
  /** 種類(パスワード / ユーザーID / APIキー・トークン / 秘密鍵) */
  kind: string;
}

export interface MaskResult {
  content: string;
  findings: MaskFinding[];
}

export interface MaskOptions {
  /** VB ソース(.vb)として文字列リテラル単位で処理するか */
  vbSource: boolean;
  /**
   * 高エントロピー文字列(ランダムな英数字列)も機械的にマスクするか。
   * 省略時は true(厳格モードが既定)。対象は文字列リテラル・コメント・
   * 設定値の中身のみで、識別子やコード構造は触らない
   */
  strict?: boolean;
}

const MASK = "[MASKED]";

const KIND_PASSWORD = "パスワード";
const KIND_USER = "ユーザーID";
const KIND_TOKEN = "APIキー/トークン";
const KIND_PRIVATE_KEY = "秘密鍵";
const KIND_ENTROPY = "高エントロピー値";

/** パスワード・秘密系とみなす変数名/キー名のヒント(日本語識別子対応) */
const SECRET_NAME_HINT =
  /pass(?:word)?|passwd|pswd|pwd|secret|credential|api[_-]?key|apikey|access[_-]?key|accesskey|secret[_-]?key|secretkey|token|パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証/i;

/** ユーザーID系とみなす変数名のヒント(VB の代入リテラル用) */
const USER_NAME_HINT = /user|uid|account|login|ユーザ|ﾕｰｻﾞ|アカウント/i;

/**
 * VB 識別子の文字クラス(日本語識別子対応)。
 * ひらがな・カタカナ・CJK 漢字・半角カナ・全角英数を含める。
 * `.` は Me.txtPassword.Text のようなメンバーアクセス用(先頭以外)
 */
const IDENT_HEAD =
  "A-Za-z_\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF66-\\uFF9F\\uFF21-\\uFF3A\\uFF41-\\uFF5A";
const IDENT_BODY = `${IDENT_HEAD}0-9.\\uFF10-\\uFF19`;

/**
 * 接続文字列・設定のキー=値(パスワード系)。
 * 値は ; " & < > 改行 まで(接続文字列のセパレータで停止)。値の先頭が
 * 空白・引用符のもの(`KEY = "..."` のようなコードの代入)は対象外にし、
 * 引用符内は文字列リテラルとして別途(高エントロピー判定で)扱う
 */
const CONNSTR_SECRET =
  /\b(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)(\s*=\s*)([^;"&<>\r\n:\s][^;"&<>\r\n]*)/gi;

/** 接続文字列のユーザー系キー(User ID / UID など明確なもののみ)。
 *  値の先頭 : は SQL バインド変数(UID = :UID 等)のため対象外 */
const CONNSTR_USER =
  /\b(user\s*id|userid|username|uid)(\s*=\s*)([^;"&<>\r\n:\s][^;"&<>\r\n]*)/gi;

/**
 * 日本語キー=値(設定ファイル・接続文字列・リテラル内)。
 * `\b` は非 ASCII に効かないため ASCII キーとは別パターンにする。
 * `=` のほか全角 `=` も対象。`:` は UI ラベル文言("パスワード: 8文字以上"等)
 * との誤爆が多いため対象外
 */
const JP_KEY_SECRET =
  /(パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号)(\s*[==]\s*)([^;"&<>\r\n\s][^;"&<>\r\n]*)/g;
const JP_KEY_USER =
  /(ユーザー?(?:ID|ID|名)|ﾕｰｻﾞｰ?ID|アカウント(?:ID|ID|名)?)(\s*[==]\s*)([^;"&<>\r\n\s][^;"&<>\r\n]*)/g;

/** XML 属性形式: password="..." など(非 VB ファイル用) */
const ATTR_SECRET =
  /\b(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*")([^"]+)(")/gi;

/** XML 属性形式の日本語キー: パスワード="..." など(非 VB ファイル用) */
const JP_ATTR_SECRET =
  /(パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号|ユーザー?(?:ID|ID|名)|ﾕｰｻﾞｰ?ID)(\s*[==]\s*")([^"]+)(")/g;

/**
 * 直前のコードが「変数 = 」で終わっているか(行継続 `_` 対応)。
 * 文字列リテラルの直前コンテキスト判定に使う
 */
const ASSIGNMENT_TAIL = new RegExp(
  `([${IDENT_HEAD}][${IDENT_BODY}]*)\\s*(?:As\\s+String\\s*)?=\\s*(?:_\\s*)?$`,
);

/** 名前付き引数(Foo(password:="x"))の直前コンテキスト */
const NAMED_ARG_TAIL = new RegExp(
  `([${IDENT_HEAD}][${IDENT_BODY}]*)\\s*:=\\s*(?:_\\s*)?$`,
);

/** 開き括弧の直前のメソッド名(callArgKind 用) */
const CALLEE_TAIL = new RegExp(`([${IDENT_HEAD}][${IDENT_BODY}]*)\\s*$`);

/** コメント内のコメントアウトされた代入('wk_Pswd = "x" など) */
const COMMENT_ASSIGN = new RegExp(
  `([${IDENT_HEAD}][${IDENT_BODY}]*)(\\s*=\\s*")([^"\\r\\n]+)(")`,
  "g",
);

/** 汎用シークレット形式(ファイル種別によらず適用) */
const TOKEN_PATTERNS: ReadonlyArray<{ kind: string; regex: RegExp }> = [
  { kind: KIND_TOKEN, regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: KIND_TOKEN, regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: KIND_TOKEN, regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: KIND_TOKEN,
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

/** Bearer トークン(bearer という語は残しトークン部のみマスク) */
const BEARER_TOKEN = /\b(bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi;

/** PRIVATE KEY ブロック(BEGIN/END 行は残し中身をマスク) */
const PRIVATE_KEY_BLOCK =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]+?(-----END [A-Z ]*PRIVATE KEY-----)/g;

/**
 * 高エントロピー文字列の候補(英数と base64/URL-safe 記号の 20 文字以上)。
 * 判定は looksHighEntropy で絞る
 */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{20,}/g;

/** 正規形の GUID(COM 参照・プロジェクト GUID 等で頻出。秘密ではない) */
const GUID_FORM =
  /^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$/;

function charClassOf(ch: string): number {
  if (ch >= "0" && ch <= "9") {
    return 0;
  }
  if (ch >= "a" && ch <= "z") {
    return 1;
  }
  if (ch >= "A" && ch <= "Z") {
    return 2;
  }
  return 3;
}

/**
 * ランダムな秘密らしさの近似判定。
 * 数字と英字の両方を含み、文字種(数字/小文字/大文字/記号)の切り替わりが
 * 長さに対して多いものだけを対象にする。一様ランダムな英数字列は約 6 割の
 * 位置で切り替わるのに対し、"Windows10Update2026Info" のような普通の語は
 * 3 割程度に留まるため、45% を閾値にする。既知トークン形式
 * (ghp_... / AKIA...)の整った並びは対象外のまま各専用パターンに任せる
 */
function looksHighEntropy(token: string): boolean {
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) {
    return false;
  }
  if (GUID_FORM.test(token)) {
    return false;
  }
  let transitions = 0;
  for (let i = 1; i < token.length; i++) {
    if (charClassOf(token.charAt(i)) !== charClassOf(token.charAt(i - 1))) {
      transitions += 1;
    }
  }
  return transitions >= Math.max(6, 0.45 * (token.length - 1));
}

/** 高エントロピー文字列のマスク(strict モード時のみ呼ばれる) */
function maskEntropyText(
  text: string,
  findings: MaskFinding[],
  toLine: (indexInText: number) => number,
): string {
  return text.replace(HIGH_ENTROPY_CANDIDATE, (token, offset: number) => {
    if (!looksHighEntropy(token)) {
      return token;
    }
    findings.push({ line: toLine(offset), kind: KIND_ENTROPY });
    return MASK;
  });
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line += 1;
    }
  }
  return line;
}

/** 接続文字列キー=値のマスク(テキスト断片に適用)。offsetBase は行番号計算用 */
function maskConnstrText(
  text: string,
  findings: MaskFinding[],
  toLine: (indexInText: number) => number,
): string {
  let result = text.replace(
    CONNSTR_SECRET,
    (whole, key: string, eq: string, _value: string, offset: number) => {
      findings.push({ line: toLine(offset), kind: KIND_PASSWORD });
      return `${key}${eq}${MASK}`;
    },
  );
  result = result.replace(
    CONNSTR_USER,
    (whole, key: string, eq: string, _value: string, offset: number) => {
      findings.push({ line: toLine(offset), kind: KIND_USER });
      return `${key}${eq}${MASK}`;
    },
  );
  result = result.replace(
    JP_KEY_SECRET,
    (whole, key: string, eq: string, _value: string, offset: number) => {
      findings.push({ line: toLine(offset), kind: KIND_PASSWORD });
      return `${key}${eq}${MASK}`;
    },
  );
  result = result.replace(
    JP_KEY_USER,
    (whole, key: string, eq: string, _value: string, offset: number) => {
      findings.push({ line: toLine(offset), kind: KIND_USER });
      return `${key}${eq}${MASK}`;
    },
  );
  return result;
}

/** 変数名のヒントからマスク種別を決める(該当なしは undefined) */
function kindForIdentifier(identifier: string): string | undefined {
  if (SECRET_NAME_HINT.test(identifier)) {
    return KIND_PASSWORD;
  }
  if (USER_NAME_HINT.test(identifier)) {
    return KIND_USER;
  }
  return undefined;
}

/**
 * 文字列リテラルが「秘密系メソッドの引数」かどうかを直前コンテキストから
 * 判定する(Login("admin", "pass123") / SetPassword("x") 等)。
 * 直近の未対応の開き括弧を遡り、その直前のメソッド名にヒントがあれば
 * そのリテラルは引数とみなす。行(改行)を跨いだら打ち切る
 */
function callArgKind(tail: string): string | undefined {
  let depth = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const ch = tail[i];
    if (ch === ")") {
      depth += 1;
    } else if (ch === "(") {
      if (depth === 0) {
        const callee = CALLEE_TAIL.exec(tail.slice(0, i));
        return callee === null ? undefined : kindForIdentifier(callee[1] ?? "");
      }
      depth -= 1;
    } else if (ch === "\n") {
      return undefined;
    }
  }
  return undefined;
}

/** コメント内のマスク(コメントアウトされた認証情報コードも対象にする) */
function maskCommentText(
  comment: string,
  findings: MaskFinding[],
  line: number,
  strict: boolean,
): string {
  let result = comment.replace(
    COMMENT_ASSIGN,
    (whole, identifier: string, assign: string, _value: string, close: string) => {
      const kind = kindForIdentifier(identifier);
      if (kind === undefined) {
        return whole;
      }
      findings.push({ line, kind });
      return `${identifier}${assign}${MASK}${close}`;
    },
  );
  result = maskConnstrText(result, findings, () => line);
  if (strict) {
    result = maskEntropyText(result, findings, () => line);
  }
  return result;
}

/**
 * VB ソースのマスク。
 * 正規表現の一発置換だとリテラル連結("Password=" & 変数 など)をまたいで
 * 誤マスクするため、コード/文字列リテラル/コメントを区別して走査する。
 * - 「秘密系変数 = "リテラル"」→ リテラル全体をマスク
 * - 名前付き引数(password:="x")・秘密系メソッドの引数リテラルもマスク
 * - それ以外のリテラル → 内部の接続文字列キー(PWD=xxx 等)のみマスク。
 *   strict 時は高エントロピー文字列もマスク
 * - コメント → コメントアウトされた代入・接続文字列もマスク
 */
function maskVbSource(
  content: string,
  findings: MaskFinding[],
  strict: boolean,
): string {
  let out = "";
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i];

    if (ch === '"') {
      // 文字列リテラルを読み取る("" は " のエスケープ。行内で閉じる前提)
      let j = i + 1;
      let inner = "";
      while (j < n) {
        if (content[j] === '"') {
          if (content[j + 1] === '"') {
            inner += '""';
            j += 2;
            continue;
          }
          break;
        }
        if (content[j] === "\n" || content[j] === "\r") {
          break;
        }
        inner += content.charAt(j);
        j += 1;
      }
      const closed = j < n && content[j] === '"';

      // 直前のコードが「秘密系変数 = 」「秘密系の名前付き引数 :=」
      // 「秘密系メソッドの引数」ならリテラル全体をマスク
      const tail = out.slice(-200);
      let kind: string | undefined;
      if (closed && inner.trim() !== "") {
        const assignMatch = ASSIGNMENT_TAIL.exec(tail);
        if (assignMatch !== null) {
          kind = kindForIdentifier(assignMatch[1] ?? "");
        }
        if (kind === undefined) {
          const namedArg = NAMED_ARG_TAIL.exec(tail);
          kind =
            namedArg !== null
              ? kindForIdentifier(namedArg[1] ?? "")
              : callArgKind(tail);
        }
      }
      if (kind !== undefined) {
        findings.push({ line: lineOf(content, i), kind });
        out += `"${MASK}"`;
        i = j + 1;
        continue;
      }

      // それ以外は接続文字列キー(strict 時は高エントロピー値も)のみマスク
      let maskedInner = maskConnstrText(inner, findings, () =>
        lineOf(content, i),
      );
      if (strict) {
        maskedInner = maskEntropyText(maskedInner, findings, () =>
          lineOf(content, i),
        );
      }
      out += `"${maskedInner}${closed ? '"' : ""}`;
      i = closed ? j + 1 : j;
      continue;
    }

    if (ch === "'") {
      // コメント: 行末まで
      let j = i;
      while (j < n && content[j] !== "\n") {
        j += 1;
      }
      out += maskCommentText(
        content.slice(i, j),
        findings,
        lineOf(content, i),
        strict,
      );
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** 非 VB ファイル(config / XML / テキスト等)のマスク */
function maskGenericText(
  content: string,
  findings: MaskFinding[],
  strict: boolean,
): string {
  // XML 属性形式(値が引用符で囲まれるため接続文字列パターンでは拾えない)
  let result = content.replace(
    ATTR_SECRET,
    (whole, key: string, eq: string, _value: string, closeQuote: string, offset: number) => {
      const kind = /user|uid/i.test(key) ? KIND_USER : KIND_PASSWORD;
      findings.push({ line: lineOf(content, offset), kind });
      return `${key}${eq}${MASK}${closeQuote}`;
    },
  );
  result = result.replace(
    JP_ATTR_SECRET,
    (whole, key: string, eq: string, _value: string, closeQuote: string, offset: number) => {
      const kind = /ユーザ|ﾕｰｻﾞ/.test(key) ? KIND_USER : KIND_PASSWORD;
      findings.push({ line: lineOf(result, offset), kind });
      return `${key}${eq}${MASK}${closeQuote}`;
    },
  );
  result = maskConnstrText(result, findings, (index) => lineOf(result, index));
  if (strict) {
    result = maskEntropyText(result, findings, (index) => lineOf(result, index));
  }
  return result;
}

/**
 * 認証情報らしき値を [MASKED] に置換し、置換箇所の一覧を返す。
 */
export function maskCredentials(content: string, options: MaskOptions): MaskResult {
  const findings: MaskFinding[] = [];
  const strict = options.strict ?? true;
  let result = options.vbSource
    ? maskVbSource(content, findings, strict)
    : maskGenericText(content, findings, strict);

  // ファイル種別によらない汎用シークレット形式
  result = result.replace(
    PRIVATE_KEY_BLOCK,
    (whole, begin: string, end: string, offset: number) => {
      findings.push({ line: lineOf(result, offset), kind: KIND_PRIVATE_KEY });
      return `${begin}\n${MASK}\n${end}`;
    },
  );
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern.regex, (whole, ...args: unknown[]) => {
      const offset = args[args.length - 2];
      findings.push({
        line: typeof offset === "number" ? lineOf(result, offset) : 1,
        kind: pattern.kind,
      });
      return MASK;
    });
  }
  result = result.replace(
    BEARER_TOKEN,
    (whole, prefix: string, _token: string, offset: number) => {
      findings.push({ line: lineOf(result, offset), kind: KIND_TOKEN });
      return `${prefix}${MASK}`;
    },
  );

  return { content: result, findings };
}

// ---------------------------------------------------------------------------
// petari 側の扱い (伏せた表示・伏せ字の行の照合と復元)
// ---------------------------------------------------------------------------

/** slnmix が置き換える伏せ字 */
export const MASK_TOKEN = MASK;

/** VB ソースとして文字列リテラル単位で伏せるか (slnmix と同じく拡張子で判定) */
export function isVbSource(path: string): boolean {
  return /\.vb$/i.test(path);
}

export function hasMaskToken(line: string): boolean {
  return line.includes(MASK);
}

function countMaskTokens(line: string): number {
  return line.split(MASK).length - 1;
}

/** 秘密鍵ブロックの本文を 1 行ずつ伏せる (行数を変えない) */
function maskPrivateKeyBodies(lines: string[]): string[] {
  let inKey = false;
  return lines.map((line) => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
      inKey = !/-----END [A-Z ]*PRIVATE KEY-----/.test(line);
      return line;
    }
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) {
        inKey = false;
        return line;
      }
      return line.trim() === "" ? line : MASK;
    }
    return line;
  });
}

/**
 * 行配列を伏せた表示を返す (行数と行の位置は元のまま)。
 * maskCredentials は秘密鍵のブロックを 1 行にまとめ、複数行にまたがる属性値でも行数が
 * 変わるため、秘密鍵の本文を先に 1 行ずつ伏せ、それでも行数が変わるときは行ごとに伏せる
 */
export function maskedLines(lines: string[], vbSource: boolean): string[] {
  const keyMasked = maskPrivateKeyBodies(lines);
  const whole = maskCredentials(keyMasked.join("\n"), { vbSource }).content.split("\n");
  if (whole.length === lines.length) return whole;
  return keyMasked.map((l) => maskCredentials(l, { vbSource }).content);
}

/**
 * 伏せた行と元の行から、伏せた値を順に取り出す。取り出せなければ null。
 * 伏せ字の前後の文字列を手がかりに左から切り出し、組み立て直して元の行に戻ることを確かめる
 */
export function extractMaskedValues(masked: string, original: string): string[] | null {
  const segments = masked.split(MASK);
  const first = segments[0] ?? "";
  if (segments.length < 2 || !original.startsWith(first)) return null;
  const values: string[] = [];
  let pos = first.length;
  for (let j = 1; j < segments.length; j++) {
    const seg = segments[j] ?? "";
    if (j === segments.length - 1) {
      if (!original.endsWith(seg) || original.length - seg.length <= pos) return null;
      values.push(original.slice(pos, original.length - seg.length));
      pos = original.length;
      break;
    }
    // 伏せ字が隣り合うと境目が決まらない
    if (seg === "") return null;
    const idx = original.indexOf(seg, pos + 1);
    if (idx < 0) return null;
    values.push(original.slice(pos, idx));
    pos = idx + seg.length;
  }
  return fillMaskTokens(masked, values) === original ? values : null;
}

/** 行の伏せ字を values で順に置き換える (数が合わなければ null) */
function fillMaskTokens(line: string, values: string[]): string | null {
  const segments = line.split(MASK);
  if (segments.length - 1 !== values.length) return null;
  let out = segments[0] ?? "";
  for (let j = 1; j < segments.length; j++) {
    out += (values[j - 1] ?? "") + (segments[j] ?? "");
  }
  return out;
}

export type MaskRestoreResult =
  | { ok: true; lines: string[]; restored: number }
  | { ok: false; line: string; reason: "no-source" | "ambiguous" };

/**
 * 書き込む行の伏せ字を、元のファイルの値に戻す。
 * 候補は元のファイルの [from, to) の行のうち、伏せた表示で値が伏せられた行。
 * 同じ文字列の行 (前後の空白は無視) があればそれを、なければ (similar のときだけ)
 * 伏せ字の数が同じ行を使い、候補から取り出せる値が 1 通りに決まるときだけ戻す。
 * similar は SEARCH の範囲に限った replace で使う (ファイル全体からの推定はしない)
 */
export function restoreMaskedLines(
  lines: string[],
  masked: string[],
  original: string[],
  range: { from: number; to: number; similar: boolean },
): MaskRestoreResult {
  const { from, to, similar } = range;
  const out: string[] = [];
  let restored = 0;
  for (const line of lines) {
    const k = countMaskTokens(line);
    if (k === 0) {
      out.push(line);
      continue;
    }
    const candidates: number[] = [];
    for (let i = Math.max(0, from); i < Math.min(to, original.length); i++) {
      const m = masked[i];
      if (m !== undefined && m !== original[i] && countMaskTokens(m) === k) candidates.push(i);
    }
    const same = candidates.filter((i) => masked[i]?.trim() === line.trim());
    const picks = same.length > 0 || !similar ? same : candidates;
    const distinct = new Map<string, string[]>();
    for (const i of picks) {
      const values = extractMaskedValues(masked[i] ?? "", original[i] ?? "");
      if (values !== null) distinct.set(JSON.stringify(values), values);
    }
    if (distinct.size !== 1) {
      return { ok: false, line, reason: distinct.size === 0 ? "no-source" : "ambiguous" };
    }
    const values = [...distinct.values()][0] ?? [];
    out.push(fillMaskTokens(line, values) ?? line);
    restored += k;
  }
  return { ok: true, lines: out, restored };
}
