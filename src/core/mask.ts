/**
 * 認証情報の伏せ字 (§7 失敗レポート / 伏せ字の行の照合)。
 *
 * slnmix がパックを作るときに認証情報らしき値を [MASKED] に置き換えるため、AI の返答
 * (SEARCH / REPLACE / CONTENT) にも [MASKED] が入る。petari は次の 3 点でこれを扱う:
 * - 失敗レポートの「実ファイルの該当箇所」を伏せる (AI に貼るレポートから実際の値が漏れない)
 * - SEARCH の [MASKED] を「伏せた後の実ファイル」と照合する (伏せ字の行も変更できる)
 * - 書き込む行の [MASKED] を元の値に戻す。戻せなければ書かずに止める
 *
 * maskCredentials / maskLinesForDisplay / maskedValuesForDisplay は slnmix の src/services/credentialMasker.ts の写し
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
 * 引用符内は文字列リテラルとして別途(高エントロピー判定で)扱う。ただし引用符で閉じた値
 * (接続文字列の `Password='a;b'`('' は ' のエスケープ)・VB の文字列の中の `Password=""a;b""`・
 * XML の属性の中の `Password=&quot;a;b&quot;`・C# / JSON の文字列の中の `Password=\"a;b\"`)は引用符の中を伏せる
 * (引用符は残す)
 */
const CONNSTR_SECRET =
  /\b(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)(\s*=\s*)(""(?![\s,;)&+|])(?:(?!"")[^\r\n])+(?<!\s)""|&quot;(?:(?!&quot;)[^"\r\n])+&quot;|&apos;(?:(?!&apos;)[^"\r\n])+&apos;|\\"(?:(?!\\")[^"\r\n])+\\"|'(?:[^'\r\n]|'')+'(?!')(?=[;"&<>\s),.\]}+|]|$)|(?![@$]{1,2}"|\\")[^;"&<>\r\n:\s][^;"&<>\r\n]*)/gi;

/** 接続文字列のキーそのもの(行頭の Password=x;Server=y は接続文字列として扱う) */
const CONNSTR_KEY_NAME =
  /^(?:password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)$/i;

/** 接続文字列の値を囲む引用符(長いものから) */
const CONNSTR_QUOTES = ["&quot;", "&apos;", '\\"', '""', "'"];

/** 接続文字列のユーザー系キー(User ID / UID など明確なもののみ)。
 *  値の先頭 : は SQL バインド変数(UID = :UID 等)のため対象外 */
const CONNSTR_USER =
  /\b(user\s*id|userid|username|uid)(\s*=\s*)(""(?![\s,;)&+|])(?:(?!"")[^\r\n])+(?<!\s)""|&quot;(?:(?!&quot;)[^"\r\n])+&quot;|&apos;(?:(?!&apos;)[^"\r\n])+&apos;|\\"(?:(?!\\")[^"\r\n])+\\"|'(?:[^'\r\n]|'')+'(?!')(?=[;"&<>\s),.\]}+|]|$)|(?![@$]{1,2}"|\\")[^;"&<>\r\n:\s][^;"&<>\r\n]*)/gi;

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

/**
 * XML 属性形式: password="..." など(非 VB ファイル用)。キーの前は英数字以外(DB_PASSWORD= / db.password= も)。
 * C# の逐語的・補間文字列(pwd = @"..." / $"...")も
 * 単一引用符の値は行内で閉じるものだけ(英文の ' を引用と取り違えて先まで伏せないように)
 */
const ATTR_SECRET =
  /(?<![A-Za-z0-9])(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*[@$]{0,2}")([^"]+(?:""[^"]*)*)(")/gi;
const ATTR_SECRET_SINGLE =
  /(?<![A-Za-z0-9])(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*')((?:[^'\\\r\n]|\\.)+)(')/gi;

/**
 * XML の開始タグの属性の並び(引用符の中の > も含める)。長さに上限を設けるのは、閉じていないタグが
 * 続いても遅くならないように
 */
const TAG_BODY = `(?:[^<>"']|"[^"]{0,4000}"|'[^']{0,4000}'){0,2000}`;

/** .NET の設定ファイルの appSettings: <add key="DbPassword" value="..." />(key と value の順はどちらでも) */
const CONFIG_ADD = new RegExp(`<add\\b${TAG_BODY}>`, "gi");
const CONFIG_ATTR = /\b(key|value)(\s*=\s*)("[^"]*"|'[^']*')/gi;

/**
 * .NET の設定(My.Settings): <setting name="DbPassword" ...><value>...</value>(app.config)と
 * <Setting Name="DbPassword" ...><Value Profile="(Default)">...</Value>(Settings.settings)。
 * リソース(.resx)の <data name="DbPassword"><value>...</value> も(表示の文言は除く)
 */
/** 要素の中身(CDATA か、タグを含まない文字列) */
const ELEMENT_TEXT = `(<!\\[CDATA\\[(?:[^\\]]|\\](?!\\]>)){0,4000}\\]\\]>|[^<]*)`;
const SETTING_VALUE = new RegExp(
  `(<(?:setting|data)\\b${TAG_BODY}>)(\\s*(?:<!--(?:[^-]|-(?!->)){0,4000}-->\\s*)*<value\\b${TAG_BODY}(?<!\\/)>)${ELEMENT_TEXT}(<\\/value>)`,
  "gi",
);

/** 名前が秘密系の要素の中身: <DbPassword>...</DbPassword>(名前の判定は置き換えの中で行う) */
const ELEMENT_VALUE = new RegExp(`(<([A-Za-z_][\\w.-]{0,200})(?:\\s${TAG_BODY})?(?<!\\/)>)${ELEMENT_TEXT}(<\\/\\2\\s*>)`, "g");
const SETTING_NAME = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * .env / .properties 形式の行(`DB_PASSWORD=...`。行頭から始まり = の前後に空白がないもの。字下げした
 * 行はコードの引数(credentials=None, など)が多いため対象外)。値は行末まで
 * (接続文字列の区切り ; & < > を含んでも途中で止めない)。キーの判定は置き換えの中で行う
 */
const ENV_LINE = /^((?:export[ \t]+)?)([A-Za-z0-9_.-]+)(=)([^\r\n]*)/gm;

/**
 * キーと文字列の値: JSON の "password": "..."、コードの dbPassword = "..." / { apiKey: '...' } など。
 * キーは識別子(途中から始めない)か引用符で囲んだもの、区切りは : か =(== などの比較は除く)。
 * キーの判定は置き換えの中で行う(正規表現に入れると、秘密系の語を多く含む長い文字列で遅くなるため)
 */
const KEY_LITERAL =
  /((?<![A-Za-z0-9_$.])[A-Za-z_$][A-Za-z0-9_$.]*|"[^"\r\n]*"|'[^'\r\n]*')(\s*(?::|=(?!=))\s*)("(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')/g;

/** 設定のキー名の最後の語(と最後の 2 語を続けたもの)がこれらなら秘密系 / ユーザー ID 系 */
const SECRET_KEY_WORDS = new Set([
  "password",
  "passwd",
  "pswd",
  "pwd",
  "pass",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "credential",
  "credentials",
]);
const USER_KEY_WORDS = new Set(["userid", "username", "uid", "user"]);
/** コードでは別の意味でも使う語(字句解析の token、HTTP の credentials など) */
const WEAK_KEY_WORDS = new Set(["token", "credential", "credentials"]);

/** 秘密ではない値: 真偽値(SavePassword = True / RequireToken = "true" などの設定)と書式の差し込みだけの値 */
function isNonSecretValue(value: string): boolean {
  return /^(?:true|false)$/i.test(value.trim()) || isPlaceholderOnly(value);
}

/**
 * 書式の差し込み(%s / {} / {0} / {1,-8:D} / {:.2f} / ${x})だけでできた値('%s:%s' など)。秘密ではないため伏せない。
 * {...} は番号か書式指定だけのもの(ODBC の接続文字列は Pwd={...} の形で値を囲むため)、${...} は名前だけのもの
 * (${DB_PASSWORD:-既定値} の既定値は伏せる)
 */
function isPlaceholderOnly(value: string): boolean {
  const PLACEHOLDER =
    /%[-+ #0]*\d*(?:\.\d+)?[sdifxXr]|\{(?:\d+(?:,-?\d+)?(?::[^{}\r\n]*)?|:[^{}A-Za-z\r\n]*[A-Za-z%]?)?\}|\$\{[A-Za-z_][A-Za-z0-9_.]*\}/g;
  return PLACEHOLDER.test(value) && !/[A-Za-z0-9]/.test(value.replace(PLACEHOLDER, ""));
}

/**
 * 設定のキー名から種別を決める(秘密系・ユーザー ID 系。該当なしは undefined)。キー名の最後の語で
 * 決める(DbPassword / DB_PASSWORD / db.password / ApiKey / api_key)。語の一部に含むだけのもの
 * (jsonwebtoken / passport / BypassProxy / passwordPlaceholder)は秘密ではない
 */
function kindForConfigKey(key: string): string | undefined {
  if (/(?:パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号)$/.test(key)) {
    return KIND_PASSWORD;
  }
  const [last, lastTwo] = lastKeyWords(key);
  if (SECRET_KEY_WORDS.has(last) || SECRET_KEY_WORDS.has(lastTwo)) {
    return KIND_PASSWORD;
  }
  return USER_KEY_WORDS.has(last) || USER_KEY_WORDS.has(lastTwo) ? KIND_USER : undefined;
}

/**
 * コードの中のキーと文字列の値(dbPassword = "..." / "token": "..." / <ApiKey>...</ApiKey>)を伏せるか。
 * 秘密系のキーで、値が表示の文言・書式の差し込みだけでないもの。token などの別の意味でも使う語のキーは、
 * 値が秘密らしい(8 文字以上で空白や $ # % 括弧などの記号を含まず、数字か大文字と小文字の両方を含む)ときだけ
 * (字句解析の token: "keyword.$0" などを伏せないように)
 */
function isSecretPair(key: string, value: string, labels = true): boolean {
  if (
    kindForConfigKey(key) !== KIND_PASSWORD ||
    value === "" ||
    value === MASK ||
    (labels && looksLikeLabel(key, value)) ||
    isNonSecretValue(value)
  ) {
    return false;
  }
  // 日本語のキー(パスワード など)は別の意味を持たない
  if (/(?:パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号)$/.test(key)) {
    return true;
  }
  const words = keyWords(key);
  const [, lastTwo] = lastKeyWords(key);
  // キーのどこかに別の意味を持たない語(secret / password など)があれば値によらず伏せる(SECRET_TOKEN など)
  if ((SECRET_KEY_WORDS.has(lastTwo) && !WEAK_KEY_WORDS.has(lastTwo)) || words.some((word) => SECRET_KEY_WORDS.has(word) && !WEAK_KEY_WORDS.has(word))) {
    return true;
  }
  return (
    value.length >= 8 &&
    !/[\s$#%{}()<>[\],;\\'"`]/.test(value) &&
    (/[0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))
  );
}

/** キー名の語(小文字。camelCase / snake_case / . / - で区切る) */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/** キー名の最後の語と、最後の 2 語を続けたもの */
function lastKeyWords(key: string): [string, string] {
  const words = keyWords(key);
  return [words[words.length - 1] ?? "", words.slice(-2).join("")];
}

/**
 * 値が秘密の値ではなく表示の文言らしいもの(日本語などを含む・空白を含む文・キー名の最後の語そのもの。
 * 多言語化の "password": "パスワード" / "Password" / "Password must be ..." など)
 */
function looksLikeLabel(key: string, value: string): boolean {
  if (/[^\x00-\x7F]/.test(value) || /\S\s+\S/.test(value)) {
    return true;
  }
  const word = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return lastKeyWords(key).includes(word);
}

/** XML 属性形式の日本語キー: パスワード="..." など(非 VB ファイル用) */
const JP_ATTR_SECRET =
  /(パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号|ユーザー?(?:ID|ID|名)|ﾕｰｻﾞｰ?ID)(\s*[==]\s*")([^"]+)(")/g;

/**
 * 直前のコードが「変数 = 」で終わっているか(行継続 `_` 対応)。
 * 文字列リテラルの直前コンテキスト判定に使う
 */
const ASSIGNMENT_TAIL = new RegExp(
  `([${IDENT_HEAD}][${IDENT_BODY}]*)\\s*(?:As\\s+String\\s*)?[&+]?=\\s*(?:_\\s*)?(?:\\(\\s*(?:_\\s*)?)*$`,
);

/** 名前付き引数(Foo(password:="x"))の直前コンテキスト */
const NAMED_ARG_TAIL = new RegExp(
  `([${IDENT_HEAD}][${IDENT_BODY}]*)\\s*:=\\s*(?:_\\s*)?$`,
);

/**
 * 秘密として丸ごと伏せたリテラルと、連結で続くリテラルの間(& / + と空白・行継続・改行の定数だけ)。
 * `pwd = "abc" & _` の次の行の `"def"` も同じ値の続き(行継続の後のコメントも間に入れてよい)
 */
const CONCAT_GAP =
  /^(?:[ \t]|_[ \t]*(?:'[^\r\n]*)?\r?\n|\r?\n|[&+]|""|vbCrLf|vbCr|vbLf|vbNewLine|vbTab|vbNullString|vbNullChar|ControlChars\.[A-Za-z]+|Environment\.NewLine|ChrW?\([ \t]*\d+[ \t]*\))*$/;
/** 接続文字列のキーと = の後に続くリテラルまでの間(& / + と空白・行継続だけ。改行の定数の後は文言とみなす) */
const CONCAT_GAP_HEAD = /^(?:[ \t]|_[ \t]*(?:'[^\r\n]*)?\r?\n|\r?\n|[&+])*$/;

/**
 * 接続文字列のキーと = で終わるリテラル("...;Password=" & "...")と、接続文字列(; の後のキー)の値が
 * リテラルの終わりまで続くもの("...;Password=Hun" & "ter2;...")。次に連結で続くリテラルの先頭(; まで)が値
 * (の続き)。後者は SQL の "WHERE pwd=1" & " AND ..." を伏せすぎないよう、; の後のキーだけ
 */
const CONNSTR_KEY_TAIL =
  /(?:\b(?:password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)\s*=\s*|;\s*(?:password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)\s*=\s*\[MASKED\])$/i;
const CONNSTR_USER_TAIL = /(?:\b(?:user\s*id|userid|username|uid)\s*=\s*|;\s*(?:user\s*id|userid|username|uid)\s*=\s*\[MASKED\])$/i;

/**
 * My.Settings の既定値(Settings.Designer.vb の DefaultSettingValueAttribute("...") の後に続く
 * プロパティ名)。名前の判定は kindForConfigKey
 */
const DEFAULT_SETTING_CALLEE = /DefaultSettingValue(?:Attribute)?\s*\(\s*$/i;
const DEFAULT_SETTING_PROPERTY =
  /^\s*\)(?:[^>\n]|\r?\n){0,300}?>\s*_?\s*\r?\n\s*(?:(?:Public|Friend|Private|Protected|Overridable|Overrides|ReadOnly|WriteOnly|Shared|Default)\s+)*Property\s+\[?([A-Za-z_][A-Za-z0-9_]*)/i;

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

/**
 * 一部だけ伏せたトークンの残り。厳格モードでは高エントロピー値の判定がトークンの形式より
 * 先に走るため、20 文字未満の部分(JWT の署名、Bearer トークンの「.」の後ろなど)が残る
 * ことがある。伏せ字を含み、伏せていない英数字も残っているものを丸ごと伏せる
 */
const PARTIAL_JWT =
  /(?:\beyJ[A-Za-z0-9_-]{8,}|\[MASKED\])\.(?:eyJ[A-Za-z0-9_-]{8,}|\[MASKED\])\.(?:[A-Za-z0-9_-]{8,}|\[MASKED\])/g;
const PARTIAL_BEARER = /\b(bearer\s+)((?:\[MASKED\]|[A-Za-z0-9._~+/-])+=*)/gi;

/**
 * 前の 2 つが伏せ字で、残りが短い(20 文字未満)並び。高エントロピーのサブドメインを伏せたホスト名
 * (`[MASKED].[MASKED].database.windows.net` など)で、トークンの残りではない。JWT の署名は 43 文字以上
 * あるため、伏せ損ねて残るのは長い並び(それは伏せる)。ただし文字列の連結(`" & _` / `" +`)や
 * 伏せ字が続くときは、署名が途中で切れている(続きがある)ので伏せる。連結が続いても、残りが
 * 小文字・数字・- だけならホスト名のラベル(`...internal" & ";Database=..."`)なので伏せない
 */
function isShortTail(whole: string, offset: number, all: string): boolean {
  const head = `${MASK}.${MASK}.`;
  if (!whole.startsWith(head) || whole.length - head.length >= 20) return false;
  const after = all.slice(offset + whole.length, offset + whole.length + 40);
  if (after.startsWith(`.${MASK}`)) return false;
  // 小文字・数字・- だけの残りはホスト名のラベル(連結が続いても伏せない)
  return !/^"\s*[&+]/.test(after) || /^[a-z0-9-]+$/.test(whole.slice(head.length));
}

/** 伏せ字を含み、伏せていない英数字も残っているか */
function isPartlyMasked(token: string): boolean {
  return token.includes(MASK) && /[A-Za-z0-9]/.test(token.split(MASK).join(""));
}

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
  const maskValue =
    (kind: string) =>
    (whole: string, key: string, eq: string, value: string, offset: number): string => {
      const quote = CONNSTR_QUOTES.find(
        (q) => value.length > 2 * q.length && value.startsWith(q) && value.endsWith(q) && (q !== "'" || /^'(?:[^'\r\n]|'')+'$/.test(value)),
      );
      const inner = quote === undefined ? value : value.slice(quote.length, -quote.length);
      // 先に伏せた値(単一引用符の属性など)・書式の差し込みだけの値は伏せない
      if (inner.trim() === MASK || isPlaceholderOnly(inner)) {
        return whole;
      }
      findings.push({ line: toLine(offset), kind });
      return quote === undefined ? `${key}${eq}${MASK}` : `${key}${eq}${quote}${MASK}${quote}`;
    };
  let result = text.replace(CONNSTR_SECRET, maskValue(KIND_PASSWORD));
  result = result.replace(CONNSTR_USER, maskValue(KIND_USER));
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
  result = maskConfigAdds(result, findings, () => line);
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
  // 直前のコード(out の末尾)の控え。out を毎回切り出すと、大きいファイルで
  // 文字列全体の複製が文字列リテラルごとに起きて遅くなるため
  let recent = "";
  // 連結で続くリテラルを伏せる手がかり: 秘密として丸ごと伏せた直前のリテラル(whole)か、接続文字列の
  // キーと = で終わる直前のリテラル(head: 続くリテラルの先頭の値を伏せる)。その後に出したコードを控える
  let secretKind: string | undefined;
  let secretPart: "whole" | "head" = "whole";
  // 先頭を伏せる値が接続文字列(; の後のキー)のものか(値がリテラルをまたいで続くかの判定に使う)
  let secretConn = false;
  let sinceSecret = "";
  const emit = (piece: string): void => {
    out += piece;
    recent += piece;
    if (recent.length > 400) {
      recent = recent.slice(-200);
    }
    if (secretKind !== undefined) {
      sinceSecret += piece;
      if (sinceSecret.length > 200) {
        secretKind = undefined;
      }
    }
  };
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content.charAt(i);

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
      const tail = recent.slice(-200);
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
        // My.Settings の既定値(続くプロパティの名前で決める)
        if (kind === undefined && DEFAULT_SETTING_CALLEE.test(tail)) {
          const property = DEFAULT_SETTING_PROPERTY.exec(content.slice(j + 1, j + 400));
          kind = property === null || isNonSecretValue(inner) ? undefined : kindForConfigKey(property[1] ?? "");
        }
      }
      const continued =
        closed &&
        inner.trim() !== "" &&
        secretKind !== undefined &&
        /[&+]/.test(sinceSecret) &&
        CONCAT_GAP.test(sinceSecret);
      // 秘密として伏せたリテラルに連結で続くリテラル
      if (kind === undefined && continued && secretPart === "whole") {
        kind = secretKind;
      }
      if (kind !== undefined) {
        findings.push({ line: lineOf(content, i), kind });
        emit(`"${MASK}"`);
        secretKind = kind;
        secretPart = "whole";
        sinceSecret = "";
        i = j + 1;
        continue;
      }

      // 接続文字列のキーと = で終わったリテラルに連結で続くリテラルは、先頭の値(; まで)を伏せる
      let head = "";
      let body = inner;
      // リテラル全体が値の続き(; がない)で、接続文字列の値なら、さらに次のリテラルにも続き得る
      let headOnly = false;
      if (continued && secretPart === "head" && secretKind !== undefined && CONCAT_GAP_HEAD.test(sinceSecret)) {
        const end = inner.indexOf(";");
        // 値の先頭が空(; で始まる)か引用符だけ(SQL の "SET Password=" & "'" & x)なら伏せない
        if (end !== 0 && !/^[\s'"`]*$/.test(end < 0 ? inner : inner.slice(0, end))) {
          findings.push({ line: lineOf(content, i), kind: secretKind });
          head = MASK;
          body = end < 0 ? "" : inner.slice(end);
          headOnly = end < 0 && secretConn;
        }
      }
      // それ以外は接続文字列キー(strict 時は高エントロピー値も)のみマスク
      let maskedInner = maskConnstrText(body, findings, () =>
        lineOf(content, i),
      );
      if (strict) {
        maskedInner = maskEntropyText(maskedInner, findings, () =>
          lineOf(content, i),
        );
      }
      maskedInner = head + maskedInner;
      emit(`"${maskedInner}${closed ? '"' : ""}`);
      const tailKind = !closed
        ? undefined
        : headOnly
          ? secretKind
          : CONNSTR_KEY_TAIL.test(maskedInner)
            ? KIND_PASSWORD
            : CONNSTR_USER_TAIL.test(maskedInner)
              ? KIND_USER
              : undefined;
      if (tailKind !== undefined) {
        secretConn = headOnly || /;[^;]*$/.test(maskedInner);
        secretKind = tailKind;
        secretPart = "head";
        sinceSecret = "";
      }
      i = closed ? j + 1 : j;
      continue;
    }

    if (ch === "'") {
      // コメント: 行末まで
      let j = i;
      while (j < n && content[j] !== "\n") {
        j += 1;
      }
      emit(
        maskCommentText(content.slice(i, j), findings, lineOf(content, i), strict),
      );
      i = j;
      continue;
    }

    emit(ch);
    i += 1;
  }
  return out;
}

/**
 * .NET の appSettings の要素(<add key="DbPassword" value="..." />)の値を伏せる(設定ファイルと VB の
 * コメントアウトした設定に使う)
 */
function maskConfigAdds(
  text: string,
  findings: MaskFinding[],
  toLine: (indexInText: number) => number,
): string {
  return text.replace(CONFIG_ADD, (tag: string, offset: number) => {
    let key: string | undefined;
    let value: string | undefined;
    for (const attr of tag.matchAll(CONFIG_ATTR)) {
      const quoted = attr[3] ?? "";
      if (attr[1]?.toLowerCase() === "key") {
        key ??= quoted.slice(1, -1);
      } else if (quoted.slice(1, -1).trim() !== "") {
        value ??= quoted.slice(1, -1).trim();
      }
    }
    const kind = key === undefined ? undefined : kindForConfigKey(key);
    // 真偽値・差し込みだけの値と、token などの別の意味でも使う語のキーの秘密らしくない値は伏せない
    // (空白を含む値はパスフレーズのことがあるため、表示の文言の例外は使わない)
    if (
      kind === undefined ||
      value === undefined ||
      value === MASK ||
      isNonSecretValue(value) ||
      (kind === KIND_PASSWORD && !isSecretPair(key ?? "", value, false))
    ) {
      return tag;
    }
    findings.push({ line: toLine(offset), kind });
    return tag.replace(CONFIG_ATTR, (attr: string, name: string, eq: string, quoted: string) => {
      const quote = quoted.charAt(0);
      return name.toLowerCase() === "value" && quoted.slice(1, -1).trim() !== ""
        ? `${name}${eq}${quote}${MASK}${quote}`
        : attr;
    });
  });
}

/**
 * 要素の中身を伏せた表示(前後の空白(改行・字下げ)と CDATA の囲みは残す)。中身が空なら undefined
 */
function maskElementText(value: string): string | undefined {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value);
  const inner = (cdata === null ? value : (cdata[1] ?? "")).trim();
  if (inner === "" || inner === MASK) {
    return undefined;
  }
  if (cdata !== null) {
    return `<![CDATA[${MASK}]]>`;
  }
  const lead = value.slice(0, value.indexOf(inner));
  return `${lead}${MASK}${value.slice(lead.length + inner.length)}`;
}

/** 非 VB ファイル(config / XML / テキスト等)のマスク */
function maskGenericText(
  content: string,
  findings: MaskFinding[],
  strict: boolean,
): string {
  // .NET の設定ファイルの appSettings / My.Settings(キー名と値が別の属性・要素にある)
  let result = maskConfigAdds(content, findings, (index) => lineOf(content, index));
  result = result.replace(
    SETTING_VALUE,
    (whole, open: string, middle: string, value: string, close: string, offset: number) => {
      const found = SETTING_NAME.exec(open);
      const name = found === null ? undefined : (found[1] ?? found[2]);
      const kind = name === undefined ? undefined : kindForConfigKey(name);
      const shown = maskElementText(value);
      // リソース(.resx)は表示の文言が多いため、文言らしい値も伏せない
      const resource = /^<data\b/i.test(open);
      const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value);
      const inner = (cdata === null ? value : (cdata[1] ?? "")).trim();
      if (
        kind === undefined ||
        shown === undefined ||
        isNonSecretValue(inner) ||
        (kind === KIND_PASSWORD && !isSecretPair(name ?? "", inner, resource)) ||
        (resource && looksLikeLabel(name ?? "", inner))
      ) {
        return whole;
      }
      findings.push({ line: lineOf(result, offset), kind });
      return `${open}${middle}${shown}${close}`;
    },
  );
  result = result.replace(
    ELEMENT_VALUE,
    (whole, open: string, name: string, value: string, close: string, offset: number) => {
      const kind = kindForConfigKey(name);
      const shown = maskElementText(value);
      const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value);
      const inner = (cdata === null ? value : (cdata[1] ?? "")).trim();
      if (kind === undefined || shown === undefined || (kind === KIND_PASSWORD && !isSecretPair(name, inner))) {
        return whole;
      }
      findings.push({ line: lineOf(result, offset), kind });
      return `${open}${shown}${close}`;
    },
  );
  
  // .env / .properties 形式の行(値は行末まで。引用符で囲んだ値は引用符を残す)
  result = result.replace(ENV_LINE, (whole, lead: string, key: string, eq: string, rest: string, offset: number) => {
    const kind = kindForConfigKey(key);
    const value = rest.trim();
    const quote = value.charAt(0);
    const quoted = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
    const inner = quoted ? value.slice(1, -1) : value;
    // 接続文字列の形の値(Password=x;Server=y / ConnectionString=Server=x;Password=y)は接続文字列として
    // ; まで伏せる。値の先頭がキーでない(DB_PASSWORD=Hunter2;Server=x)なら、先頭で判定して全体を伏せる
    const listed = !quoted && /;\s*[A-Za-z][A-Za-z0-9 _.-]*=/.test(inner);
    const head = listed ? (inner.split(";")[0] ?? "").trim() : inner;
    if (
      kind === undefined ||
      inner === "" ||
      inner === MASK ||
      (listed && (head.includes("=") || CONNSTR_KEY_NAME.test(key))) ||
      (kind === KIND_PASSWORD ? !isSecretPair(key, head) : isPlaceholderOnly(head))
    ) {
      return whole;
    }
    findings.push({ line: lineOf(result, offset), kind });
    const at = rest.indexOf(value);
    const shown = quoted ? `${quote}${MASK}${quote}` : MASK;
    return `${lead}${key}${eq}${rest.slice(0, at)}${shown}${rest.slice(at + value.length)}`;
  });
  // XML 属性形式(値が引用符で囲まれるため接続文字列パターンでは拾えない)
  for (const regex of [ATTR_SECRET, ATTR_SECRET_SINGLE]) {
    result = result.replace(
      regex,
      (whole, key: string, eq: string, value: string, closeQuote: string, offset: number) => {
        // 値が空白・書式の差し込みだけのもの・先に伏せたもの、閉じた引用符の後のコードの連結("Password=" & _ の
        // 次の行の " まで)は伏せない
        if (value.trim() === "" || value === MASK || isPlaceholderOnly(value) || /^\s*[&+][\s_]/.test(value)) {
          return whole;
        }
        const kind = /user|uid/i.test(key) ? KIND_USER : KIND_PASSWORD;
        // 前に語が付いたキー(DB_PASSWORD / this.next_token など)はキー全体で判定する
        // (. の前はオブジェクトの名前なので除く。this.token / spring.datasource.password はキーそのまま)
        const path = /[A-Za-z0-9_.-]*$/.exec(result.slice(Math.max(0, offset - 200), offset))?.[0] ?? "";
        const prefix = path.slice(path.lastIndexOf(".") + 1);
        if (
          prefix !== "" &&
          (kindForConfigKey(prefix + key) !== kind || (kind === KIND_PASSWORD && !isSecretPair(prefix + key, value, false)))
        ) {
          return whole;
        }
        findings.push({ line: lineOf(result, offset), kind });
        return `${key}${eq}${MASK}${closeQuote}`;
      },
    );
  }
  result = result.replace(
    JP_ATTR_SECRET,
    (whole, key: string, eq: string, _value: string, closeQuote: string, offset: number) => {
      const kind = /ユーザ|ﾕｰｻﾞ/.test(key) ? KIND_USER : KIND_PASSWORD;
      findings.push({ line: lineOf(result, offset), kind });
      return `${key}${eq}${MASK}${closeQuote}`;
    },
  );
  // キーと文字列の値("password": "..." / dbPassword = "..." / { apiKey: '...' })
  result = result.replace(KEY_LITERAL, (whole, key: string, sep: string, literal: string, offset: number) => {
    const name = /^["']/.test(key) ? key.slice(1, -1) : key;
    // : はオブジェクト・辞書・行頭(コメントの次の行・YAML も)のキーだけ(三項演算子の cond ? "password" : "text" を除く)
    const before = result.slice(Math.max(0, offset - 200), offset);
    const lineStart = /[{,[(\n][ \t]*$/.test(before) || (offset <= 200 && /^[ \t]*$/.test(before));
    if (sep.includes(":") && !lineStart) {
      return whole;
    }
    if (!isSecretPair(name, literal.slice(1, -1))) {
      return whole;
    }
    findings.push({ line: lineOf(result, offset), kind: KIND_PASSWORD });
    const quote = literal.charAt(0);
    return `${key}${sep}${quote}${MASK}${quote}`;
  });
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
  // 一部だけ伏せたトークンの残り(伏せ字がなければ探さない)
  if (result.includes(MASK)) {
    result = result.replace(PARTIAL_JWT, (whole: string, offset: number, all: string) =>
      isPartlyMasked(whole) && !isShortTail(whole, offset, all) ? MASK : whole,
    );
    result = result.replace(PARTIAL_BEARER, (whole: string, prefix: string, token: string) =>
      isPartlyMasked(token) ? `${prefix}${MASK}` : whole,
    );
  }

  // 大きい文字列を控えに残したままにしない
  lineIndexText = undefined;
  lineIndexBreaks = [];
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
  /**
   * VB のソースとして伏せるか。パックでの伏せ方が分かっているとき (slnmix build) に指定する。
   * 省略時は拡張子から、パックが取り得る伏せ方をすべて使う (.vb は VB / 汎用テキストの両方)
   */
  vbSource?: boolean;
}

/** 抜粋で伏せる範囲 (どの伏せ方でも伏せる範囲を合わせたもの)。対応づけられない伏せ方があれば null */
function displaySpans(text: string, options: MaskLinesOptions): MaskSpan[] | null {
  const all: MaskSpan[] = [];
  // 厳格モードの結果は厳格でない結果を含むとは限らない(トークンの形式の判定の順番など)ため、
  // strict のときは両方の範囲を伏せる
  const stricts = (options.strict ?? true) ? [true, false] : [false];
  const vbSource = options.vbSource;
  const modes =
    vbSource === undefined ? maskModes(options.path, stricts) : stricts.map((strict) => ({ vbSource, strict }));
  for (const mode of modes) {
    const spans = maskedSpans(text, mode);
    if (spans === null) return null;
    // 伏せた範囲が多いファイル (大きな埋め込み画像など) で引数の上限を超えないよう 1 つずつ足す
    for (const span of spans) all.push(span);
  }
  return mergeSpans(all);
}

/**
 * AI に渡す抜粋のための伏せた表示 (行の数と位置は元のまま)。
 * slnmix のパックが取り得るどの伏せ方 (.vb を VB として / 汎用テキストとして、strict の有無) でも伏せられる範囲を
 * すべて伏せる。伏せた範囲を元の位置に対応づけられない伏せ方があれば、空行以外をすべて伏せる (安全側)
 */
export function maskLinesForDisplay(lines: string[], options: MaskLinesOptions): string[] {
  const text = lines.join("\n");
  const spans = displaySpans(text, options);
  if (spans === null) {
    return lines.map((l) => (l.trim() === "" ? l : `${/^\s*/.exec(l)?.[0] ?? ""}${MASK}`));
  }
  return linesFromSpans(lines, text, spans).map((l) => l.text);
}

/**
 * 抜粋 (maskLinesForDisplay) で伏せる元の値 (行ごとに分け、前後の空白を除き、重複なし)。抜粋の外の
 * 文面 (ビルドエラーの本文など) に同じ値が出たときに伏せるため。対応づけられない伏せ方があれば null
 */
export function maskedValuesForDisplay(lines: string[], options: MaskLinesOptions): string[] | null {
  const text = lines.join("\n");
  const spans = displaySpans(text, options);
  if (spans === null) return null;
  const values = new Set<string>();
  for (const span of spans) {
    for (const part of text.slice(span.start, span.end).split("\n")) {
      const value = part.trim();
      if (value !== "" && value !== MASK) values.add(value);
    }
  }
  return [...values];
}

// ---------------------------------------------------------------------------
// petari 側の扱い (伏せ字の行の照合と復元)
// ---------------------------------------------------------------------------

/**
 * 照合と伏せ字の復元に使う伏せた表示。slnmix のパックが取り得る伏せ方ごとと、失敗レポート・
 * ビルドエラーの抜粋 (maskLinesForDisplay) と同じ合わせ方のもの (抜粋から写した SEARCH 用) を作る。
 * 同じ表示になるものは 1 つにまとめ、対応づけられない伏せ方は含めない
 */
export function maskedViews(lines: string[], path: string): MaskedLine[][] {
  const text = lines.join("\n");
  const views: MaskedLine[][] = [];
  const seen = new Set<string>();
  const add = (spans: MaskSpan[]): void => {
    if (spans.length === 0) return;
    const view = linesFromSpans(lines, text, spans);
    const key = view.map((l) => l.text).join("\n");
    if (seen.has(key)) return;
    seen.add(key);
    views.push(view);
  };
  const modes = maskModes(path, [true, false]);
  const spansByMode = modes.map((mode) => maskedSpans(text, mode));
  for (const spans of spansByMode) {
    if (spans !== null) add(spans);
  }
  for (const stricts of [[true, false], [false]]) {
    const group = spansByMode.filter((_, k) => stricts.includes(modes[k]?.strict ?? true));
    if (group.every((spans) => spans !== null)) add(mergeSpans(group.flatMap((spans) => spans ?? [])));
  }
  return views;
}

/**
 * 伏せる元の値ごとの数 (抜粋と同じ伏せ方で、行ごとに分け前後の空白を除いたもの)。変更の前後で伏せた
 * 値が減るかを数えるため。対応づけられない伏せ方があれば null
 */
export function maskedValueCounts(lines: string[], path: string): Map<string, number> | null {
  const text = lines.join("\n");
  const spans = displaySpans(text, { path });
  if (spans === null) return null;
  const counts = new Map<string, number>();
  for (const span of spans) {
    for (const part of text.slice(span.start, span.end).split("\n")) {
      const value = part.trim();
      if (value !== "" && value !== MASK) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return counts;
}

function fillMaskTokens(line: string, values: string[]): string {
  const segments = line.split(MASK);
  let out = segments[0] ?? "";
  for (let j = 1; j < segments.length; j++) {
    out += (values[j - 1] ?? "") + (segments[j] ?? "");
  }
  return out;
}

export interface MaskRestoreFailure {
  line: string;
  reason: "no-source" | "ambiguous" | "copied" | "unseparable";
}

export type MaskRestoreResult =
  | {
      ok: true;
      lines: string[];
      /** 元の値に戻した伏せ字の数 */
      restored: number;
      /** literal の指定で [MASKED] の文字のまま書いた数 */
      literal: number;
      /** 元の値に戻した行ごとの、戻す元にした行 (range の中の行番号)。戻していない行は null */
      sources: (number | null)[];
    }
  | {
      ok: false;
      /** 戻せない行のすべて */
      failures: MaskRestoreFailure[];
      /** literal の指定があったが、範囲に実際の値を伏せた行があるため使わなかった */
      literalRefused: boolean;
      /** literal を指定すれば書ける (範囲に実際の値を伏せた行がなく、戻せない行がすべて no-source) */
      literalAllowed: boolean;
    };

/**
 * 書き込む行の伏せ字を元の値に戻す。
 * 戻すのは、元のファイルの [from, to) にある伏せた行と (前後の空白を除いて) 同じ文字列の行だけ
 * (伏せ字の行をそのまま残した場合)。伏せ字の行を書き換えた・新しく足した行は、値の取り違えや
 * コメントへの書き出しを避けるため戻さない (no-source)。同じ文字列の行が複数あって値が 1 通りに
 * 決まらなければ ambiguous。複数行にまたがる値の一部・1 つに伏せた複数の値の行は戻せない (unseparable)。
 * 実際の値を伏せた行を元の範囲より多く書くなら、写して足した行がありどれが元の行か決まらないため copied
 * (キーが別の行にある `<value>[MASKED]</value>`・INI のセクションや If の分岐の中の `pwd = [MASKED]` を写すと、
 * 別のキー・別の場所に同じ値を書くことになるため)。literal のときは no-source の行を [MASKED] の文字のまま書く
 * (伏せ字を扱うコードそのものを書く場合の明示の指定)。ただし範囲に実際の値を伏せた行があるときは
 * literal を使わない (伏せ字の行を書き換えた回答で、実際の値を [MASKED] の文字で上書きしないため)
 */
export function restoreMaskedLines(
  lines: string[],
  views: MaskedLine[][],
  range: { from: number; to: number },
  options: { literal?: boolean } = {},
): MaskRestoreResult {
  // 範囲の伏せた行を、前後の空白を除いた表示ごとにまとめる (元の値の組の重複は除く)
  type Candidate = { values: string[] | null; source: number; sources: Set<number> };
  const index = new Map<string, Map<string, Candidate>>();
  // 範囲にある同じ表示の行の数 (伏せ方ごとに数えて多いほう)
  const sourceCount = new Map<string, number>();
  let hasRealValue = false;
  for (const view of views) {
    const counts = new Map<string, number>();
    for (let i = Math.max(0, range.from); i < Math.min(range.to, view.length); i++) {
      const v = view[i];
      if (v === undefined || !hasMaskToken(v.text)) continue;
      if (v.values === null || v.values.some((value) => value !== MASK)) hasRealValue = true;
      const key = v.text.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      sourceCount.set(key, Math.max(sourceCount.get(key) ?? 0, counts.get(key) ?? 0));
      const candidates = index.get(key) ?? new Map<string, Candidate>();
      const valuesKey = JSON.stringify(v.values);
      const known = candidates.get(valuesKey);
      if (known === undefined) {
        candidates.set(valuesKey, { values: v.values, source: i, sources: new Set([i]) });
      } else {
        known.sources.add(i);
      }
      index.set(key, candidates);
    }
  }
  const literal = options.literal === true && !hasRealValue;
  const out: string[] = [];
  const sources: (number | null)[] = [];
  const failures: MaskRestoreFailure[] = [];
  let restored = 0;
  let literalCount = 0;
  const written = new Map<string, number>();
  for (const line of lines) {
    if (hasMaskToken(line)) written.set(line.trim(), (written.get(line.trim()) ?? 0) + 1);
  }
  for (const line of lines) {
    if (!hasMaskToken(line)) {
      out.push(line);
      sources.push(null);
      continue;
    }
    // 戻せない形 (値を分けられない・複数行の値の一部) の候補は、同じ行が別の伏せ方で戻せるなら除く
    // (汎用テキストの伏せ方だけが `"Password=" & _` の次の行までを 1 つの値とみなす場合など)
    const all = [...(index.get(line.trim())?.values() ?? [])];
    const restorable = new Set(all.flatMap((c) => (c.values === null ? [] : [...c.sources])));
    const candidates = all.filter((c) => c.values !== null || [...c.sources].some((src) => !restorable.has(src)));
    if (candidates.length === 0) {
      if (literal) {
        out.push(line);
        sources.push(null);
        literalCount += line.split(MASK).length - 1;
      } else {
        failures.push({ line, reason: "no-source" });
      }
      continue;
    }
    const only = candidates[0];
    if (candidates.length === 1 && only !== undefined && only.values === null) {
      failures.push({ line, reason: "unseparable" });
      continue;
    }
    if (
      candidates.length > 1 ||
      only === undefined ||
      only.values === null ||
      only.values.length !== line.split(MASK).length - 1
    ) {
      failures.push({ line, reason: "ambiguous" });
      continue;
    }
    // 実際の値を伏せた行を元より多く書くなら、写して足した行がある (別のキー・別の場所に同じ値を書き得る)
    const real = only.values.some((value) => value !== MASK);
    if (real && (written.get(line.trim()) ?? 0) > (sourceCount.get(line.trim()) ?? 0)) {
      failures.push({ line, reason: "copied" });
      continue;
    }
    out.push(fillMaskTokens(line, only.values));
    sources.push(only.source);
    // 実ファイルにもともと [MASKED] という文字がある行は、その文字に戻る (数えない)
    restored += only.values.filter((value) => value !== MASK).length;
  }
  if (failures.length > 0) {
    return {
      ok: false,
      failures,
      literalRefused: options.literal === true && hasRealValue,
      literalAllowed: !hasRealValue && failures.every((f) => f.reason === "no-source"),
    };
  }
  return { ok: true, lines: out, restored, literal: literalCount, sources };
}
