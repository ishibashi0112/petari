/**
 * 認証情報の伏せ字 (§7 失敗レポート / 伏せ字の行の照合)。
 *
 * slnmix がパックを作るときに認証情報らしき値を [MASKED] に置き換えるため、AI の返答
 * (SEARCH / REPLACE / CONTENT) にも [MASKED] が入る。petari は次の 3 点でこれを扱う:
 * - 失敗レポートの「実ファイルの該当箇所」を伏せる (AI に貼るレポートから実際の値が漏れない)
 * - SEARCH の [MASKED] を「伏せた後の実ファイル」と照合する (伏せ字の行も変更できる)
 * - 書き込む行の [MASKED] を元の値に戻す。戻せなければ書かずに止める
 *
 * maskCredentials と maskLinesForDisplay は slnmix の src/services/credentialMasker.ts の写し
 * (slnmix 0.22.2 時点)。判定を変えるときは両方を揃える (slnmix と petari の統合で 1 つに戻す。設計書 §25)。
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

/** lineOf の改行位置の控え(同じ文字列への問い合わせが続くため。大きいファイルで遅くならないように) */
let lineIndexText: string | undefined;
let lineIndexBreaks: number[] = [];

function lineOf(text: string, index: number): number {
  if (text !== lineIndexText) {
    lineIndexBreaks = [];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x0a) {
        lineIndexBreaks.push(i);
      }
    }
  }
  // 内容が同じ別の文字列なら控えをそのまま使い、次からは同じ文字列として速く比べられるようにする
  lineIndexText = text;
  // index より前にある改行の数 + 1
  let lo = 0;
  let hi = lineIndexBreaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((lineIndexBreaks[mid] ?? 0) < index) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo + 1;
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
// 伏せた表示 (行の位置を保つ)。slnmix のビルドエラーの抜粋と同じ処理
// ---------------------------------------------------------------------------

/** slnmix が置き換える伏せ字 */
export const MASK_TOKEN = MASK;

export function hasMaskToken(line: string): boolean {
  return line.includes(MASK);
}

/** 伏せ方 (slnmix のパックが取り得る組み合わせ) */
interface MaskMode {
  vbSource: boolean;
  strict: boolean;
}

/** 伏せた範囲 (元の文字列の位置。tokens は隣り合った伏せ字をまとめた数) */
interface MaskSpan {
  start: number;
  end: number;
  tokens: number;
}

/**
 * slnmix が使い得る伏せ方。.vb は VB として伏せるのが通常だが、generic 構成の追加ディレクトリでは
 * 汎用テキストとして伏せる。strict は --no-strict-mask で切られる
 */
function maskModes(path: string, stricts: boolean[]): MaskMode[] {
  const vbs = /\.vb$/i.test(path) ? [true, false] : [false];
  return vbs.flatMap((vbSource) => stricts.map((strict) => ({ vbSource, strict })));
}

/** 秘密鍵ブロックの置換 (BEGIN と END の間を「改行 + 伏せ字 + 改行」にする) の跡 */
const COLLAPSED_PRIVATE_KEY =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)\n\[MASKED\]\n(-----END [A-Z ]*PRIVATE KEY-----)/g;

/**
 * maskCredentials が伏せた範囲を、元の文字列の位置で返す。
 * 伏せる処理は「元の文字列の一部を [MASKED] に置き換える」だけ (秘密鍵ブロックの改行を除く) なので、
 * 伏せた結果を [MASKED] で区切った各部分を元の文字列から順に探して位置を決める。
 * 区切りの部分は通常長い (次の伏せ字までの全文) ため位置は一意に決まり、最後に組み立て直して確かめる。
 * 対応づけられなければ null (呼び出し側は安全側に倒す)
 */
function maskedSpans(text: string, mode: MaskMode): MaskSpan[] | null {
  const masked = maskCredentials(text, mode).content.replace(
    COLLAPSED_PRIVATE_KEY,
    (_whole, begin: string, end: string) => `${begin}${MASK}${end}`,
  );
  const segments = masked.split(MASK);
  const head = segments[0] ?? "";
  if (!text.startsWith(head)) return null;
  const spans: MaskSpan[] = [];
  let pos = head.length;
  let tokens = 0;
  let spanStart = pos;
  for (let j = 1; j < segments.length; j++) {
    const seg = segments[j] ?? "";
    tokens += 1;
    if (seg === "" && j < segments.length - 1) {
      // 伏せ字が隣り合う: 境目は決められないので 1 つの範囲にまとめる
      continue;
    }
    const end = j === segments.length - 1 ? text.length - seg.length : text.indexOf(seg, pos + 1);
    if (end <= pos || (j === segments.length - 1 && !text.endsWith(seg))) return null;
    spans.push({ start: spanStart, end, tokens });
    pos = end + seg.length;
    spanStart = pos;
    tokens = 0;
  }
  if (pos !== text.length && segments.length > 1) return null;
  if (segments.length === 1 && masked !== text) return null;
  return spans;
}

/** 伏せた表示の 1 行 */
export interface MaskedLine {
  /** 伏せた表示 (伏せ字のない行は元の行と同じ) */
  text: string;
  /**
   * 伏せ字ごとの元の値 (左から順)。伏せ字のない行は空配列。
   * 元の値を 1 つずつに分けられない行と、複数行にまたがる値の一部を伏せた行は null (戻さない)
   */
  values: string[] | null;
  /**
   * 複数行にまたがる値 (秘密鍵の本文・複数行の属性値) の一部を伏せた行。slnmix のパックでは
   * これらの行は 1 行にまとめて表示されるため、AI が写した SEARCH とは本来一致しない
   */
  wrapped: boolean;
}

/**
 * 伏せた範囲を行ごとに当てはめる (行の数と位置は元のまま)。
 * 複数行にまたがる範囲は各行の該当部分をそれぞれ伏せる (行頭・行末の空白は残す)
 */
function linesFromSpans(lines: string[], text: string, spans: MaskSpan[]): MaskedLine[] {
  const out: MaskedLine[] = [];
  let lineStart = 0;
  let k = 0;
  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    while (k < spans.length && (spans[k]?.end ?? 0) <= lineStart) k += 1;
    let shown = "";
    const values: string[] = [];
    let separable = true;
    let wrapped = false;
    let cursor = lineStart;
    for (let j = k; j < spans.length; j++) {
      const span = spans[j];
      if (span === undefined || span.start >= lineEnd) break;
      let from = Math.max(span.start, lineStart);
      let to = Math.min(span.end, lineEnd);
      if (span.start < lineStart || span.end > lineEnd) {
        wrapped = true;
        while (from < to && /\s/.test(text.charAt(from))) from += 1;
        while (to > from && /\s/.test(text.charAt(to - 1))) to -= 1;
      }
      if (to <= from) continue;
      shown += text.slice(cursor, from) + MASK.repeat(span.tokens);
      if (span.tokens === 1) values.push(text.slice(from, to));
      else separable = false;
      cursor = to;
    }
    shown += text.slice(cursor, lineEnd);
    out.push({ text: shown, values: separable && !wrapped ? values : null, wrapped });
    lineStart = lineEnd + 1;
  }
  return out;
}

/** 重なる・接する範囲をまとめる (表示用。値は使わない) */
function mergeSpans(spans: MaskSpan[]): MaskSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: MaskSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end, tokens: 1 });
    }
  }
  return merged;
}

export interface MaskLinesOptions {
  /** ファイルのパス (拡張子で伏せ方を選ぶ) */
  path: string;
  /** 高エントロピー文字列も伏せるか (省略時は true) */
  strict?: boolean;
}

/**
 * AI に渡す抜粋のための伏せた表示 (行の数と位置は元のまま)。
 * slnmix のパックが取り得るどの伏せ方 (.vb を VB として / 汎用テキストとして) でも伏せられる範囲を
 * すべて伏せる。伏せた範囲を元の位置に対応づけられない伏せ方があれば、空行以外をすべて伏せる (安全側)
 */
export function maskLinesForDisplay(lines: string[], options: MaskLinesOptions): string[] {
  const text = lines.join("\n");
  const all: MaskSpan[] = [];
  for (const mode of maskModes(options.path, [options.strict ?? true])) {
    const spans = maskedSpans(text, mode);
    if (spans === null) {
      return lines.map((l) => (l.trim() === "" ? l : `${/^\s*/.exec(l)?.[0] ?? ""}${MASK}`));
    }
    all.push(...spans);
  }
  return linesFromSpans(lines, text, mergeSpans(all)).map((l) => l.text);
}

// ---------------------------------------------------------------------------
// petari 側の扱い (伏せ字の行の照合と復元)
// ---------------------------------------------------------------------------

/**
 * 照合と伏せ字の復元に使う伏せた表示。slnmix のパックが取り得る伏せ方ごとに作る
 * (同じ表示になるものは 1 つにまとめる)。対応づけられない伏せ方は含めない
 */
export function maskedViews(lines: string[], path: string): MaskedLine[][] {
  const text = lines.join("\n");
  const views: MaskedLine[][] = [];
  const seen = new Set<string>();
  for (const mode of maskModes(path, [true, false])) {
    const spans = maskedSpans(text, mode);
    if (spans === null || spans.length === 0) continue;
    const view = linesFromSpans(lines, text, spans);
    const key = view.map((l) => l.text).join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    views.push(view);
  }
  return views;
}

function fillMaskTokens(line: string, values: string[]): string {
  const segments = line.split(MASK);
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
 * 書き込む行の伏せ字を元の値に戻す。
 * 戻すのは、元のファイルの [from, to) にある伏せた行と (前後の空白を除いて) 同じ文字列の行だけ
 * (伏せ字の行をそのまま残した場合)。伏せ字の行を書き換えた・新しく足した行は、値の取り違えや
 * コメントへの書き出しを避けるため戻さない (no-source)。同じ文字列の行が複数あって値が 1 通りに
 * 決まらなければ ambiguous。literal のときは no-source の行を [MASKED] の文字のまま書く
 * (伏せ字を扱うコードそのものを書く場合の明示の指定)
 */
export function restoreMaskedLines(
  lines: string[],
  views: MaskedLine[][],
  range: { from: number; to: number },
  options: { literal?: boolean } = {},
): MaskRestoreResult {
  const out: string[] = [];
  let restored = 0;
  for (const line of lines) {
    if (!hasMaskToken(line)) {
      out.push(line);
      continue;
    }
    const key = line.trim();
    const distinct = new Map<string, string[] | null>();
    for (const view of views) {
      for (let i = Math.max(0, range.from); i < Math.min(range.to, view.length); i++) {
        const v = view[i];
        if (v === undefined || v.text.trim() !== key) continue;
        distinct.set(JSON.stringify(v.values), v.values);
      }
    }
    const values = [...distinct.values()];
    if (values.length === 0) {
      if (options.literal === true) {
        out.push(line);
        continue;
      }
      return { ok: false, line, reason: "no-source" };
    }
    const only = values[0];
    if (values.length > 1 || only === null || only === undefined) {
      return { ok: false, line, reason: "ambiguous" };
    }
    out.push(fillMaskTokens(line, only));
    // 実ファイルにもともと [MASKED] という文字がある行は、その文字に戻る (数えない)
    restored += only.filter((v) => v !== MASK).length;
  }
  return { ok: true, lines: out, restored };
}
