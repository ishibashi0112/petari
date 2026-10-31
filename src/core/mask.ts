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
 * 引用符内は文字列リテラルとして別途(高エントロピー判定で)扱う。ただし単一引用符で囲んだ値
 * (接続文字列の `Password='a;b'`)は引用符の中を伏せる(引用符は残す)。キーの前は英数字以外
 * (DB_PASSWORD= / db.password= も)
 */
const CONNSTR_SECRET =
  /(?<![A-Za-z0-9])(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)(\s*=\s*)('[^'\r\n]+'|[^;"'&<>\r\n:\s][^;"&<>\r\n]*)/gi;

/** 接続文字列のユーザー系キー(User ID / UID など明確なもののみ)。
 *  値の先頭 : は SQL バインド変数(UID = :UID 等)のため対象外 */
const CONNSTR_USER =
  /(?<![A-Za-z0-9])(user\s*id|userid|username|uid)(\s*=\s*)('[^'\r\n]+'|[^;"'&<>\r\n:\s][^;"&<>\r\n]*)/gi;

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
 * 単一引用符の値は行内で閉じるものだけ(英文の ' を引用と取り違えて先まで伏せないように)
 */
const ATTR_SECRET =
  /(?<![A-Za-z0-9])(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*")([^"]+)(")/gi;
const ATTR_SECRET_SINGLE =
  /(?<![A-Za-z0-9])(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*')([^'\r\n]+)(')/gi;

/**
 * XML の開始タグの属性の並び(引用符の中の > も含める)。長さに上限を設けるのは、閉じていないタグが
 * 続いても遅くならないように
 */
const TAG_BODY = `(?:[^<>"]|"[^"]{0,4000}"){0,2000}`;

/** .NET の設定ファイルの appSettings: <add key="DbPassword" value="..." />(key と value の順はどちらでも) */
const CONFIG_ADD = new RegExp(`<add\\b${TAG_BODY}>`, "gi");
const CONFIG_ATTR = /\b(key|value)(\s*=\s*")([^"]*)(")/gi;

/**
 * .NET の設定(My.Settings): <setting name="DbPassword" ...><value>...</value>(app.config)と
 * <Setting Name="DbPassword" ...><Value Profile="(Default)">...</Value>(Settings.settings)
 */
const SETTING_VALUE = new RegExp(
  `(<setting\\b${TAG_BODY}>)(\\s*<value\\b${TAG_BODY}(?<!\\/)>)([^<]*)(<\\/value>)`,
  "gi",
);
const SETTING_NAME = /\bname\s*=\s*"([^"]*)"/i;

/**
 * JSON などの "password": "..."(キーに秘密系の語を含む。キーと値は同じ種類の引用符)。キーの判定は
 * 置き換えの中で行う(正規表現に入れると、秘密系の語を多く含む長い文字列で遅くなるため)
 */
const JSON_PAIR = /"([^"\r\n]*)"(\s*:\s*")((?:[^"\\\r\n]|\\.)+)(")/g;
const JSON_PAIR_SINGLE = /'([^'\r\n]*)'(\s*:\s*')((?:[^'\\\r\n]|\\.)+)(')/g;

/** 設定のキー名から種別を決める(秘密系・ユーザー ID 系。該当なしは undefined) */
function kindForConfigKey(key: string): string | undefined {
  if (SECRET_NAME_HINT.test(key)) {
    return KIND_PASSWORD;
  }
  return /user\s*id|userid|username|(?<![A-Za-z])uid(?![A-Za-z])/i.test(key) ? KIND_USER : undefined;
}

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

/**
 * 秘密として丸ごと伏せたリテラルと、連結で続くリテラルの間(& / + と空白・行継続・改行の定数だけ)。
 * `pwd = "abc" & _` の次の行の `"def"` も同じ値の続き
 */
const CONCAT_GAP =
  /^(?:[ \t]|_[ \t]*\r?\n|\r?\n|[&+]|vbCrLf|vbCr|vbLf|vbNewLine|vbTab|ControlChars\.[A-Za-z]+|Environment\.NewLine)*$/;

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
      // 先に伏せた値(単一引用符の属性など)は数え直さない
      if (value === `'${MASK}'`) {
        return whole;
      }
      findings.push({ line: toLine(offset), kind });
      return value.startsWith("'") ? `${key}${eq}'${MASK}'` : `${key}${eq}${MASK}`;
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
  // 秘密として丸ごと伏せた直前のリテラルの種別と、その後に出したコード(連結で続くリテラルの判定用)
  let secretKind: string | undefined;
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
        // 秘密として伏せたリテラルに連結で続くリテラル
        if (kind === undefined && secretKind !== undefined && /[&+]/.test(sinceSecret) && CONCAT_GAP.test(sinceSecret)) {
          kind = secretKind;
        }
      }
      if (kind !== undefined) {
        findings.push({ line: lineOf(content, i), kind });
        emit(`"${MASK}"`);
        secretKind = kind;
        sinceSecret = "";
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
      emit(`"${maskedInner}${closed ? '"' : ""}`);
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

/** 非 VB ファイル(config / XML / テキスト等)のマスク */
function maskGenericText(
  content: string,
  findings: MaskFinding[],
  strict: boolean,
): string {
  // .NET の設定ファイルの appSettings / My.Settings(キー名と値が別の属性・要素にある)
  let result = content.replace(CONFIG_ADD, (tag: string, offset: number) => {
    let key: string | undefined;
    let hasValue = false;
    for (const attr of tag.matchAll(CONFIG_ATTR)) {
      if (attr[1]?.toLowerCase() === "key") {
        key ??= attr[3];
      } else if ((attr[3] ?? "").trim() !== "") {
        hasValue = true;
      }
    }
    const kind = key === undefined ? undefined : kindForConfigKey(key);
    if (kind === undefined || !hasValue) {
      return tag;
    }
    findings.push({ line: lineOf(content, offset), kind });
    return tag.replace(CONFIG_ATTR, (attr: string, name: string, eq: string, value: string, close: string) =>
      name.toLowerCase() === "value" && value.trim() !== "" ? `${name}${eq}${MASK}${close}` : attr,
    );
  });
  result = result.replace(
    SETTING_VALUE,
    (whole, open: string, middle: string, value: string, close: string, offset: number) => {
      const name = SETTING_NAME.exec(open)?.[1];
      const kind = name === undefined ? undefined : kindForConfigKey(name);
      const inner = value.trim();
      if (kind === undefined || inner === "") {
        return whole;
      }
      findings.push({ line: lineOf(result, offset), kind });
      // 値の前後の空白(改行・字下げ)は残す
      const lead = value.slice(0, value.indexOf(inner));
      const trail = value.slice(lead.length + inner.length);
      return `${open}${middle}${lead}${MASK}${trail}${close}`;
    },
  );
  // XML 属性形式(値が引用符で囲まれるため接続文字列パターンでは拾えない)
  for (const regex of [ATTR_SECRET, ATTR_SECRET_SINGLE]) {
    result = result.replace(
      regex,
      (whole, key: string, eq: string, _value: string, closeQuote: string, offset: number) => {
        const kind = /user|uid/i.test(key) ? KIND_USER : KIND_PASSWORD;
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
  // JSON などのキーと値("password": "...")
  for (const regex of [JSON_PAIR, JSON_PAIR_SINGLE]) {
    result = result.replace(regex, (whole, key: string, sep: string, _value: string, close: string, offset: number) => {
      if (!SECRET_NAME_HINT.test(key)) {
        return whole;
      }
      findings.push({ line: lineOf(result, offset), kind: KIND_PASSWORD });
      const quote = whole.charAt(0);
      return `${quote}${key}${quote}${sep}${MASK}${close}`;
    });
  }
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
  reason: "no-source" | "ambiguous";
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
 * 決まらなければ ambiguous。literal のときは no-source の行を [MASKED] の文字のまま書く
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
  const index = new Map<string, Map<string, { values: string[] | null; source: number }>>();
  let hasRealValue = false;
  for (const view of views) {
    for (let i = Math.max(0, range.from); i < Math.min(range.to, view.length); i++) {
      const v = view[i];
      if (v === undefined || !hasMaskToken(v.text)) continue;
      if (v.values === null || v.values.some((value) => value !== MASK)) hasRealValue = true;
      const key = v.text.trim();
      const candidates = index.get(key) ?? new Map<string, { values: string[] | null; source: number }>();
      const valuesKey = JSON.stringify(v.values);
      if (!candidates.has(valuesKey)) candidates.set(valuesKey, { values: v.values, source: i });
      index.set(key, candidates);
    }
  }
  const literal = options.literal === true && !hasRealValue;
  const out: string[] = [];
  const sources: (number | null)[] = [];
  const failures: MaskRestoreFailure[] = [];
  let restored = 0;
  let literalCount = 0;
  for (const line of lines) {
    if (!hasMaskToken(line)) {
      out.push(line);
      sources.push(null);
      continue;
    }
    const candidates = [...(index.get(line.trim())?.values() ?? [])];
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
    if (
      candidates.length > 1 ||
      only === undefined ||
      only.values === null ||
      only.values.length !== line.split(MASK).length - 1
    ) {
      failures.push({ line, reason: "ambiguous" });
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
