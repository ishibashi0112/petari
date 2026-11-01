/**
 * 認証情報の伏せ字 (§7 失敗レポート / 伏せ字の行の照合)。
 *
 * petari pack (旧 slnmix) がパックを作るときに認証情報らしき値を [MASKED] に置き換えるため、AI の返答
 * (SEARCH / REPLACE / CONTENT) にも [MASKED] が入る。適用では次の 3 点でこれを扱う:
 * - 失敗レポートの「実ファイルの該当箇所」を伏せる (AI に貼るレポートから実際の値が漏れない)
 * - SEARCH の [MASKED] を「伏せた後の実ファイル」と照合する (伏せ字の行も変更できる)
 * - 書き込む行の [MASKED] を元の値に戻す。戻せなければ書かずに止める
 *
 * 伏せる処理 (maskCredentials) はパック・petari build のエラーの文面・適用の失敗レポートで共通の 1 本
 * (0.15.0 の統合で slnmix の credentialMasker.ts の写しから 1 つに戻した。設計書 §25)。旧 slnmix のパック
 * (言語ごとの伏せ方の前の版) から写した SEARCH も照合できるよう、照合用の表示は旧版の伏せ方の分も作る。
 * I/O を持たない純粋ロジック。
 */

import { literalRegions, sourceLanguageOf, type SourceLanguage } from "./source-lexer.ts";

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
   * VB 以外で、言語の分かるソースとして伏せる(source-lexer.ts。設計書 §25.7)。汎用テキストとして伏せた範囲の
   * うち、文字列・コメント・数値の中の部分だけを伏せ、コードの部分(`process.env.API_KEY` など)は戻す。
   * 省略時は汎用テキストとして伏せる。vbSource が true なら使わない
   */
  language?: SourceLanguage | undefined;
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
 * (引用符は残す)。ODBC の波括弧で囲んだ値(`Pwd={a;b}`。`}}` は `}` のエスケープ)は、閉じた波括弧の後が
 * ; ・引用符・行末などなら波括弧ごと伏せる(後ろに続きがあれば区切りまで伏せる)。
 * Python の接頭辞つきの文字列(username=b"..." / password = u"...")は接頭辞を残して引用符の中を伏せる
 */
const CONNSTR_SECRET =
  /\b(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)(\s*=\s*)(""(?![\s,;)&+|])(?:(?!"")[^\r\n])+(?<!\s)""|&quot;(?:(?!&quot;)[^"\r\n])+&quot;|&apos;(?:(?!&apos;)[^"\r\n])+&apos;|\\"(?:(?!\\")[^"\r\n])+\\"|'(?:[^'\r\n]|'')+'(?!')(?=[;"&<>\s),.\]}+|`\u0080-\uffff]|$)|'(?:[^'\r\n]|'')+'(?!')[^;"&<>\r\n]*|\{(?:[^{}"\r\n]|\}\})*\}(?=[ \t]*(?:[;"'\\<),\r\n]|&(?:quot|apos|amp);|$))|[rRuUbBfF]{1,2}(?:"(?:[^"\\\r\n]|\\.)+"|'(?:[^'\\\r\n]|\\.)+')(?![A-Za-z0-9_'"\u0080-\uffff.@])|(?![@$]{1,2}"|\\")[^;"&<>\r\n:\s][^;"&<>\r\n]*)/gi;

/** 接続文字列のキーそのもの(行頭の Password=x;Server=y は接続文字列として扱う) */
const CONNSTR_KEY_NAME =
  /^(?:password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)$/i;

/**
 * URL の利用者情報のパスワード(postgres://user:PASS@host / redis://:PASS@host)。パスワードは最後の @ まで
 * (符号化していない @ を含むもの。XML の &amp; なども)。スキームは語の途中から始めない(長い語で各位置から読み直さないように)
 */
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:\/?#@"'<>;]*:)((?:&(?:[A-Za-z]+|#[0-9]+|#[xX][0-9A-Fa-f]+);|[^\s\/?#"'<>;])+)@/g;

/**
 * URL のパスワードの位置の差し込み・伏せ字(${pass} / ${encodeURIComponent(pass)} / $PASS / {pass} / #{pass} /
 * {{pass}} / %(pass)s / {0} / %s / ***)。$ で始まる名前は大文字だけのもの($ecretPass1 は値)。
 * 既定値つきの ${PASS:-既定値} / ${PASS-既定値} / ${PASS:=既定値} は既定値が見えるため伏せる
 */
function isUrlPlaceholder(value: string): boolean {
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=+]/.test(value)) {
    return false;
  }
  return (
    isPlaceholderOnly(value) ||
    isShellVariable(value) ||
    /^(?:[$#]?\{[^{}\r\n]*\}|\{\{[^{}]*\}\}|%\([A-Za-z_][A-Za-z0-9_]*\)s|\*+)$/.test(value)
  );
}

/**
 * バッチの set の値の終わり(source の start から)。quote は値を囲む引用符(set "K=V の " / \" / "" / &quot;。
 * set K=V は "")。囲んだ値は、引用符の外の & | < > か行末より前の最後の引用符まで(cmd と同じ)。囲まない値は引用符の外の
 * & | < > か行末まで(" と &quot; で引用符の中と外が入れ替わる。引用符の外の ^ の後の文字はそのままの文字、&apos; は文字)。
 * inString(行の前の部分の " が奇数個 = 文字列・属性の中)なら文字列を閉じる " で終わる(\" と "" は文字列の中の引用符、
 * 直後が空白・区切り(, ; ) + & など)でない " は値の中の引用符)。inParen(閉じていない ( がある)なら引用符の外の ) で終わる。
 * 1 文字ずつ読み、終わりで止まる(続きはその後ろから探すので、1 行に set が多数並んでも全体を何度も読まない)
 */
function batchValueEnd(source: string, start: number, quote: string, inString: boolean, inParen: boolean): number {
  const token = quote === "" ? '"' : quote;
  let quoted = quote !== "";
  let lastQuote = -1;
  let i = start;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\r" || ch === "\n") {
      break;
    }
    if (quote !== "") {
      if (source.startsWith(token, i)) {
        lastQuote = i;
        quoted = !quoted;
        i += token.length;
        continue;
      }
      // \" / "" / &quot; で囲んだ値の外側の文字列・属性は、ただの " で終わる
      if (token !== '"' && ch === '"') {
        break;
      }
    } else if (ch === '"') {
      if (inString && source.charAt(i - 1) !== "\\") {
        if (source.charAt(i + 1) === '"') {
          quoted = !quoted;
          i += 2;
          continue;
        }
        if (i + 1 === source.length || /[\s),;+&/>\]}.]/.test(source.charAt(i + 1))) {
          break;
        }
      }
      quoted = !quoted;
      i++;
      continue;
    } else if (source.startsWith("&quot;", i)) {
      quoted = !quoted;
      i += 6;
      continue;
    }
    if (!quoted) {
      if (ch === "^") {
        i += /[\r\n]/.test(source.charAt(i + 1)) ? 1 : 2;
        continue;
      }
      if (source.startsWith("&apos;", i)) {
        i += 6;
        continue;
      }
      if (ch === "&" || ch === "|" || ch === "<" || ch === ">" || (inParen && ch === ")")) {
        break;
      }
    }
    i++;
  }
  return quote !== "" && lastQuote >= 0 ? lastQuote : Math.min(i, source.length);
}

/**
 * 行の位置より前の部分の状態(" の数・閉じていない ( の数・行の先頭の位置)。位置を増える順に
 * 問い合わせる前提で、前回の位置から読み進める(1 行に set が多数並んでも全体を読み直さない)
 */
function lineHeadScanner(source: string): (offset: number) => { quotes: number; depth: number; lineStart: number } {
  let pos = 0;
  let quotes = 0;
  let depth = 0;
  let lineStart = 0;
  return (offset) => {
    if (offset < pos) {
      pos = source.lastIndexOf("\n", offset - 1) + 1;
      lineStart = pos;
      quotes = 0;
      depth = 0;
    }
    for (; pos < offset; pos++) {
      const ch = source.charAt(pos);
      if (ch === "\n") {
        lineStart = pos + 1;
        quotes = 0;
        depth = 0;
      } else if (ch === '"') {
        quotes++;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
    }
    return { quotes, depth, lineStart };
  };
}

/**
 * 環境変数の形の KEY=value の value を伏せた表示(伏せないものは undefined)。引用符で囲んだ値は引用符を残す。
 * 変数の参照だけの値($DB_PASS。batch のときは %DB_PASS% / %1 も)・書式の差し込みは伏せない
 */
function maskedEnvValue(key: string, value: string, labels: boolean, batch = false): string | undefined {
  const kind = kindForConfigKey(key);
  const quote = value.charAt(0);
  const quoted = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
  const inner = quoted ? value.slice(1, -1) : value;
  if (
    kind === undefined ||
    inner.trim() === "" ||
    inner === MASK ||
    isShellVariable(inner, batch) ||
    (kind === KIND_PASSWORD ? !isSecretPair(key, inner, labels) : isPlaceholderOnly(inner))
  ) {
    return undefined;
  }
  return quoted ? `${quote}${MASK}${quote}` : MASK;
}

/**
 * シェルの変数の参照だけの値($DB_PASS / ${DB_PASS})。batch のときはバッチファイルの %DB_PASS% / %1 / %~1 / %%a /
 * !DB_PASS! も(.env や URL の %...% / !...! は値のことがあるため、バッチの set とコマンドの引数だけ)
 */
function isShellVariable(value: string, batch = false): boolean {
  return (
    /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value) ||
    (batch && /^(?:%~?[0-9*]|%%~?[A-Za-z]|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!)$/.test(value))
  );
}

/** 接続文字列の値を囲む引用符(長いものから) */
const CONNSTR_QUOTES = ["&quot;", "&apos;", '\\"', '""', "'"];

/** 接続文字列のユーザー系キー(User ID / UID など明確なもののみ)。
 *  値の先頭 : は SQL バインド変数(UID = :UID 等)のため対象外 */
const CONNSTR_USER =
  /\b(user\s*id|userid|username|uid)(\s*=\s*)(""(?![\s,;)&+|])(?:(?!"")[^\r\n])+(?<!\s)""|&quot;(?:(?!&quot;)[^"\r\n])+&quot;|&apos;(?:(?!&apos;)[^"\r\n])+&apos;|\\"(?:(?!\\")[^"\r\n])+\\"|'(?:[^'\r\n]|'')+'(?!')(?=[;"&<>\s),.\]}+|`\u0080-\uffff]|$)|'(?:[^'\r\n]|'')+'(?!')[^;"&<>\r\n]*|\{(?:[^{}"\r\n]|\}\})*\}(?=[ \t]*(?:[;"'\\<),\r\n]|&(?:quot|apos|amp);|$))|[rRuUbBfF]{1,2}(?:"(?:[^"\\\r\n]|\\.)+"|'(?:[^'\\\r\n]|\\.)+')(?![A-Za-z0-9_'"\u0080-\uffff.@])|(?![@$]{1,2}"|\\")[^;"&<>\r\n:\s][^;"&<>\r\n]*)/gi;

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
  /(?<![A-Za-z0-9])(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*')((?:[^'\\\r\n]|\\.)+|[^'\r\n]+)(')/gi;

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
 * (接続文字列の区切り ; & < > を含んでも途中で止めない。空白の後の # からは行末のコメント)。
 * キーの判定は置き換えの中で行う。docker-compose のリストの項目(- DB_PASSWORD=... / - "DB_PASSWORD=..." /
 * - 'DB_PASSWORD=...')も
 */
const ENV_LINE = /^((?:export[ \t]+|[ \t]*-[ \t]+["']?)?)([A-Za-z0-9_.-]+)(=)([^\r\n]*)/gm;

/** Dockerfile の ENV / ARG の命令(KEY=value を空白で区切って並べたもの。行末の \ で続く行も) */
const DOCKER_ENV = /^((?:ENV|ARG)[ \t]+)((?:[^\r\n]*\\[ \t]*\r?\n)*[^\r\n]*)/gm;

/** Dockerfile の ENV / ARG の KEY=value(値は空白まで。\ の後の空白は値のうち。引用符で囲んだものは引用符まで) */
const DOCKER_PAIR = /(?<![^ \t\r\n])([A-Za-z_][A-Za-z0-9_.-]*)(=)("(?:[^"\\\r\n]|\\.)*"|"[^"\r\n]*"|'[^'\r\n]*'|(?:\\[^\r\n]|[^\s"'\\])*)/g;

/**
 * バッチファイルの set の始まり(set DB_PASSWORD= / set "DB_PASSWORD= / @set / if ... set / ... & set。字下げした行も。
 * C の文字列の set \"K= / VB・C# の set ""K= / MSBuild の Exec などの XML の set &quot;K= も)。値の終わりは batchValueEnd で決める
 */
const BATCH_SET = /(?<=^|[ \t@(&|;"'>])([Ss][Ee][Tt][ \t]+)(\\"|""|"|&quot;)?([A-Za-z0-9_.-]+)(=)/gm;

/**
 * パスワードを引数で渡すコマンドの名前(sqlcmd / osql / isql / bcp の -P、mysql 系の -p... / --password=、
 * net use の共有の後の引数、schtasks の /RP・/P)。パスの途中の語・別の拡張子のファイル名
 * (/var/lib/mysql/・mysql.py・MySql.Data)は除く。MSBuild の &quot;...\SQLCMD.EXE&quot; と %SQLCMD% も読む
 */
const CLI_COMMAND =
  /(?<![\w.-])(sqlcmd|osql|isql|bcp|mysql|mysqldump|mysqladmin|mysqlimport|net[ \t]+use|schtasks)(?:\.exe)?(?=["'\s,\]%!]|&(?:quot|apos);|$)/gi;
/** 引数の区切りの空白(行の継続(バッチの ^ / シェルの \ の後の改行)も) */
const CLI_SP = String.raw`(?:[ \t]|\^\r?\n|(?<=[ \t])\\\r?\n)+`;
/** 引用符で囲まない値の文字(行の継続の ^ / \ は値に含めない) */
const CLI_BARE = (excluded: string): string => String.raw`(?:[^\s"'` + "`" + String.raw`^\\${excluded}]|[\^\\](?![\r\n]|$))+`;
/** 引用符で囲んだ値("..." / '...' / MSBuild の &quot;...&quot;) */
const CLI_QUOTED = String.raw`"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|&quot;(?:(?!&quot;)[^\r\n])*&quot;`;
const CLI_VALUE = `${CLI_QUOTED}|${CLI_BARE("")}`;
/** コマンドの種類ごとの、パスワードの引数(lead = 値の前、value = 値) */
const CLI_ARGS: ReadonlyArray<readonly [RegExp, readonly RegExp[]]> = [
  [
    // -P は SQL Server 認証のパスワードなので -U と一緒に使う(説明文の BCP 47 ... -Pending などは除く)
    /^(?:sqlcmd|osql|isql|bcp)$/i,
    [
      // -P value / "-P", "value"(JSON・YAML の一覧)/ '-P', 'value'(Python の一覧)/ -P"value" / -Pvalue
      new RegExp(String.raw`((?<=[\s"'\[,;])-P${CLI_SP})(${CLI_VALUE})`, "g"),
      /((?<=[\s"'\[,])-P"[ \t]*,[ \t]*")((?:[^"\\\r\n]|\\.)*)/g,
      /((?<=[\s'\[,])-P'[ \t]*,[ \t]*')([^'\r\n]*)/g,
      new RegExp(String.raw`((?<=[\s;])-P)(${CLI_QUOTED})`, "g"),
      new RegExp(String.raw`((?<=[\s"';])-P)(${CLI_BARE(",\\]")})`, "g"),
    ],
  ],
  [
    /^mysql(?:dump|admin|import)?$/i,
    [
      new RegExp(String.raw`((?<=[\s"';])-p)(${CLI_VALUE})`, "g"),
      new RegExp(String.raw`((?<=[\s"';])--password=)(${CLI_VALUE})`, "g"),
    ],
  ],
  // mysqladmin password 新しいパスワード
  [/^mysqladmin$/i, [new RegExp(String.raw`((?<=\s)password${CLI_SP})(${CLI_VALUE})`, "g")]],
  [
    /^net[ \t]+use$/i,
    [
      // net use [Z: | *] \\srv\share [/user:x ...] パスワード
      new RegExp(
        String.raw`(^net[ \t]+use(?:${CLI_SP}(?:[A-Za-z]:|\*))?${CLI_SP}(?:"\\\\[^"\r\n]*"|&quot;\\\\(?:(?!&quot;)[^\r\n])*&quot;|\\\\[^\s"` +
          "`" +
          String.raw`]+)(?:${CLI_SP}\/[A-Za-z]+(?::(?:"[^"\r\n]*"|[^\s"]*))?)*${CLI_SP})(?![\/*])(${CLI_VALUE})`,
        "i",
      ),
    ],
  ],
  [/^schtasks$/i, [new RegExp(String.raw`((?<=\s)\/(?:rp|p)${CLI_SP})(?!\/)(${CLI_VALUE})`, "gi")]],
];
/** コマンド名のない引数の文字列(ProcessStartInfo.Arguments = "-S srv -U sa -P ...")の -U ユーザー -P パスワード */
const CLI_USER_PASSWORD = new RegExp(
  String.raw`((?<=[\s"'])-U[ \t]*(?:${CLI_QUOTED}|[^\s"'` + "`" + String.raw`]+)[ \t]+-P[ \t]*)(${CLI_VALUE})`,
  "g",
);

/**
 * コマンドの引数の終わり(引用符の外の | & < > と、空白が続く ;、継続しない改行の前)。&quot; は引用符、
 * &amp; / &lt; / &gt; は区切り(MSBuild の Exec の属性)。^ は次の文字をそのまま読む(バッチ)
 */
function cliCommandEnd(text: string, start: number, limit = text.length): number {
  let quoted = false;
  const stop = Math.min(limit, text.length);
  for (let i = start; i < stop; i++) {
    const ch = text.charAt(i);
    if (ch === "\n" || ch === "\r") {
      const prev = text.charAt(i - 1);
      // シェルの \ は空白の後のものだけ(パスの末尾の \ は継続ではない)
      if (i > start && (prev === "^" || (prev === "\\" && /[ \t]/.test(text.charAt(i - 2))))) {
        if (ch === "\r" && text.charAt(i + 1) === "\n") {
          i += 1;
        }
        continue;
      }
      return i;
    }
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "&" && text.startsWith("&quot;", i)) {
      quoted = !quoted;
      i += 5;
    } else if (quoted) {
      continue;
    } else if (ch === "^") {
      if (text.charAt(i + 1) !== "\r" && text.charAt(i + 1) !== "\n") {
        i += 1;
      }
    } else if (ch === "&" && text.startsWith("&apos;", i)) {
      i += 5;
    } else if (ch === "<" || ch === ">") {
      // 2>nul / 1>&2 の番号はリダイレクトのうち
      return /[ \t][0-9]$/.test(text.slice(Math.max(start, i - 2), i)) ? i - 1 : i;
    } else if (ch === "|" || ch === "&" || ch === "`" || (ch === ";" && /^(?:\s|$)/.test(text.charAt(i + 1)))) {
      return i;
    }
  }
  return stop;
}

/** コマンドの引数の値のうち伏せないもの(変数の参照・差し込み・入力を求める * ・リダイレクトなどの記号・ポートの指定・連結) */
function cliQuote(value: string): string {
  if (value.length >= 12 && value.startsWith("&quot;") && value.endsWith("&quot;")) {
    return "&quot;";
  }
  return /^["']/.test(value) && value.length >= 2 && value.endsWith(value.charAt(0)) ? value.charAt(0) : "";
}

function isCliNonSecret(value: string): boolean {
  const quote = cliQuote(value);
  const inner = quote === "" ? value : value.slice(quote.length, -quote.length);
  return (
    inner.trim() === "" ||
    inner === MASK ||
    inner === "*" ||
    isShellVariable(inner, true) ||
    isPlaceholderOnly(inner) ||
    // $Password(PowerShell)/ $$MYSQL_PASSWORD(compose)/ $env:X / ${x} / {password}(f 文字列)/ {{ x }} / $(Prop)(MSBuild)/
    // $(cat ...) ・ `...`(コマンドの置き換え)/ <password> ・ [password](説明文の書き方)
    /^(?:\$\$?[A-Za-z_]+|\$\$?\{[A-Za-z_]\w*\}|\$env:[A-Za-z_]\w*|\{[A-Za-z_][\w.]*\}|\{\{[^{}]*\}\}|\$\([\w.]+\)|<[^<>]*>|\[[^\[\]]*\])$/i.test(inner) ||
    /^(?:\$\(|`)/.test(inner) ||
    (quote === "" && /^(?:[<>|&^\/*`-]|\d>|[\d.]+(?::\d+)+(?:\/(?:tcp|udp))?$)/.test(inner)) ||
    (quote !== "" && /^\s*[&+.]\s|\s[&+.]\s*$|^\s+[&+]|[&+]\s+$/.test(inner))
  );
}

/** パスワードを引数で渡すコマンドの値を伏せる(コマンド名より後ろの、そのコマンドの引数だけを読む) */
function maskCliArgs(source: string, findings: MaskFinding[]): string {
  const spans: { start: number; end: number }[] = [];
  const command = new RegExp(CLI_COMMAND.source, CLI_COMMAND.flags);
  for (let m = command.exec(source); m !== null; m = command.exec(source)) {
    const end = cliCommandEnd(source, m.index + m[0].length);
    // 同じ区切りの中の各種類のコマンドの最初の位置から後ろを、その種類の引数として読む
    const firsts = new Map<number, number>();
    const inner = new RegExp(CLI_COMMAND.source, CLI_COMMAND.flags);
    const segment = source.slice(m.index, end);
    for (let c = inner.exec(segment); c !== null; c = inner.exec(segment)) {
      const name = c[1] ?? "";
      const at = c.index;
      // ユーザー名・コンテナ名などの値(sudo -u mysql / docker run --name mysql)はコマンドではない
      if (/(?:^|\s)(?:-[ugh]|--(?:user|group|name|hostname|host))[ \t]+$/.test(source.slice(Math.max(0, m.index + at - 40), m.index + at))) {
        continue;
      }
      CLI_ARGS.forEach(([kindName], kind) => {
        if (kindName.test(name) && !firsts.has(kind)) {
          firsts.set(kind, at);
        }
      });
    }
    for (const [kind, at] of firsts) {
      const tail = segment.slice(at);
      if (kind === 0 && !/(?<=[\s"'\[,])-U(?!-)/.test(tail)) {
        continue;
      }
      for (const pattern of CLI_ARGS[kind]?.[1] ?? []) {
        const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
        for (let a = re.exec(tail); a !== null; a = re.exec(tail)) {
          const lead = a[1] ?? "";
          const value = a[2] ?? "";
          if (a[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          if (value === "^" || value === "\\" || isCliNonSecret(value)) {
            continue;
          }
          const quote = cliQuote(value);
          const start = m.index + at + a.index + lead.length + quote.length;
          spans.push({ start, end: start + value.length - quote.length * 2 });
          if (!pattern.flags.includes("g")) {
            break;
          }
        }
      }
    }
    command.lastIndex = Math.max(end, m.index + m[0].length);
  }
  // コマンド名のない引数の文字列の -U ユーザー -P パスワード
  const userPassword = new RegExp(CLI_USER_PASSWORD.source, CLI_USER_PASSWORD.flags);
  for (let a = userPassword.exec(source); a !== null; a = userPassword.exec(source)) {
    const valueStart = a.index + (a[1] ?? "").length;
    // PostgreSQL のコマンドの -P はパスワードではない(psql -P pager=off / createuser -P / pgbench -P 5)
    const near = source.slice(Math.max(0, a.index - 300), a.index);
    const lineHead = near.slice(near.lastIndexOf("\n") + 1);
    if (/(?<![\w.-])(?:psql|createuser|createdb|pgbench|pg_dump|pg_dumpall|pg_restore|dropdb|dropuser|vacuumdb|reindexdb|clusterdb|pg_basebackup)(?:\.exe)?\b/i.test(lineHead)) {
      continue;
    }
    let value = a[2] ?? "";
    const quote = cliQuote(value);
    if (quote === "") {
      // 引用符で囲まない値はリダイレクトなどの前まで(-P x>log.txt)
      value = value.slice(0, Math.max(0, cliCommandEnd(source, valueStart, valueStart + value.length) - valueStart));
    }
    if (value === "" || value === "^" || value === "\\" || isCliNonSecret(value)) {
      continue;
    }
    spans.push({ start: valueStart + quote.length, end: valueStart + value.length - quote.length });
  }
  if (spans.length === 0) {
    return source;
  }
  spans.sort((x, y) => x.start - y.start);
  let out = "";
  let last = 0;
  for (const span of spans) {
    if (span.start < last) {
      continue;
    }
    findings.push({ line: lineOf(source, span.start), kind: KIND_PASSWORD });
    out += source.slice(last, span.start) + MASK;
    last = span.end;
  }
  return out + source.slice(last);
}

/**
 * SQL の SET col=... の値がバインド変数(`:LOGIN_PASSWORD` / `@p1` / `$1` / `?` / `%s`)か。名前が列名と同じもの、
 * 後ろに , / WHERE が続くもの、前の行に UPDATE があるものだけ(バッチの set ADMIN_PASSWORD=@admin は値として伏せる)
 */
function isBindMarkerFor(key: string, after: string, before: string): boolean {
  const m = /^(?:[@:]([A-Za-z_]\w*)|[@:$]\d+|\?|%s)(?=[\s,)"'`]|$)/.exec(after);
  if (m === null) {
    return false;
  }
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = m[1];
  return (
    (name !== undefined && norm(name) === norm(key)) ||
    /^[ \t]*(?:,|where\b)/i.test(after.slice(m[0].length)) ||
    /\bupdate\b/i.test(
      before
        .split(/\r?\n/)
        .slice(-2)
        .filter((line) => !/^\s*(?:@?rem\b|::)/i.test(line))
        .join("\n"),
    )
  );
}

/** コマンドの引数の環境変数(docker run -e DB_PASSWORD=... / --env "DB_PASSWORD=...") */
const SHELL_ENV_ARG =
  /(?<=[ \t])((?:-e|--env)(?:[ \t]+|=))("(?:[^"\\\r\n]|\\.)*"|"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\\r\n]|\\.)*"|"[^"\r\n]*"|'[^'\r\n]*'|(?:\\[^\r\n]|[^\s"'\\])*))/g;

/** キーの値の文字列(C# の @"..." / $"..." / $@"..."、Python の u"..." / r'...' / f"..." / b"..." なども) */
const KEY_VALUE = String.raw`((?:\$?@|@\$)"(?:[^"\r\n]|"")*"|(?:\$|[rRuUbBfF]{1,2})?"(?:[^"\\\r\n]|\\.)*"|(?:[rRuUbBfF]{1,2})?'(?:[^'\\\r\n]|\\.)*')`;
/** 型の注釈の型(string / Optional[str] / Map<K, V> / string | null) */
const KEY_TYPE = String.raw`[A-Za-z_$][\w$.]*(?:<[^<>\r\n]*>|\[[^\[\]\r\n]*\])*\??`;

/**
 * キーと文字列の値: JSON の "password": "..."、コードの dbPassword = "..." / { apiKey: '...' } など。
 * キーは識別子(途中から始めない)か引用符で囲んだもの、区切りは : か =(== などの比較は除く)のほか、
 * VB の As 型(汎用テキストとして伏せる .vb の Dim pwd As String = "...")・C# の自動プロパティの初期化子
 * ({ get; set; } = "..." / { get; } = "...")・Go の := も認める。
 * キーの判定は置き換えの中で行う(正規表現に入れると、秘密系の語を多く含む長い文字列で遅くなるため)
 */
const KEY_LITERAL = new RegExp(
  String.raw`((?<![A-Za-z0-9_$.])[A-Za-z_$][A-Za-z0-9_$.]*|"[^"\r\n]*"|'[^'\r\n]*')` +
    String.raw`(\s*(?:(?<=[ \t])[Aa][Ss][ \t]+[A-Za-z_][\w.]*(?:\(\))?[ \t]*=(?!=)` +
    String.raw`|\{[ \t]*get;[ \t]*(?:(?:(?:public|private|protected|internal)[ \t]+)*(?:set|init);[ \t]*)?\}[ \t]*=(?!=)` +
    String.raw`|:=|:|=(?!=))\s*)` +
    KEY_VALUE,
  "g",
);

/**
 * 型の注釈つきのキーと文字列の値(TS / Python の password: string = "..." / password:str="...")。KEY_LITERAL の後に
 * 別に探す(同じ式に入れると case "prod": dbPassword = "..." の dbPassword を型と読み、その代入を探し直さないため)。
 * : の後に空白のないものは、別の意味でも使う語(token など)のキーでは型が文字列(str / string など)のときだけ
 * (gcloud の書式指定の last_synced_token:label="Last_Synced_Token" などを伏せないように)
 */
const KEY_LITERAL_TYPED = new RegExp(
  String.raw`((?<![A-Za-z0-9_$.])[A-Za-z_$][A-Za-z0-9_$.]*)` +
    String.raw`(\s*:[ \t]*${KEY_TYPE}(?:[ \t]*\|[ \t]*${KEY_TYPE})*[ \t]*=(?!=)\s*)` +
    KEY_VALUE,
  "g",
);

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
 * 秘密系のキーで、値が表示の文言・書式の差し込み・キー名そのもの(SET_PASSWORD = "SetPassword")でないもの。
 * token などの別の意味でも使う語のキーは、値が秘密らしい(8 文字以上で空白や $ # % 括弧などの記号を含まず、
 * 数字を含むか、大文字と小文字を含み語をつないだ識別子の形でない)ときだけ(字句解析の token: "keyword.$0"・
 * AWS SDK のページ送りの "input_token": "nextToken" などを伏せないように)
 */
function isSecretPair(key: string, value: string, labels = true): boolean {
  if (
    kindForConfigKey(key) !== KIND_PASSWORD ||
    value === "" ||
    value === MASK ||
    (labels && looksLikeLabel(key, value)) ||
    namesKey(key, value) ||
    isNonSecretValue(value)
  ) {
    return false;
  }
  // キーのどこかに別の意味を持たない語(secret / password など)があれば値によらず伏せる(SECRET_TOKEN など)
  if (hasStrongSecretWord(key)) {
    return true;
  }
  return (
    value.length >= 8 &&
    !/[\s$#%{}()<>[\],;\\'"`]/.test(value) &&
    (/[0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value) && !looksLikeWords(value)))
  );
}

/**
 * 値が語をつないだ識別子の形(nextToken / NextPageToken / InvalidationList.NextMarker / XMLHttpRequest)か。
 * camelCase で区切った各語が「(大文字 1 字 +)小文字」か「大文字 2 字以上」で、2 字以下の語が少ないもの
 * (ランダムな英字の並び Atza|IQEBLjAsAhRkcxQ は 1 字だけの大文字の語や短い語ができるため語に区切れない)
 */
function looksLikeWords(value: string): boolean {
  const words = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .split(/[^A-Za-z]+/)
    .filter((word) => word !== "");
  return (
    words.length > 0 &&
    words.every((word) => /^(?:[A-Z]?[a-z]+|[A-Z]{2,})$/.test(word)) &&
    words.filter((word) => word.length <= 2).length <= Math.max(1, words.length / 4)
  );
}

/** キーに別の意味を持たない秘密系の語(password / secret / 日本語のパスワード など。token などは除く)があるか */
function hasStrongSecretWord(key: string): boolean {
  if (/(?:パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号)$/.test(key)) {
    return true;
  }
  const [, lastTwo] = lastKeyWords(key);
  return (
    (SECRET_KEY_WORDS.has(lastTwo) && !WEAK_KEY_WORDS.has(lastTwo)) ||
    keyWords(key).some((word) => SECRET_KEY_WORDS.has(word) && !WEAK_KEY_WORDS.has(word))
  );
}

/** キー名の語(小文字。camelCase / snake_case / . / - で区切る。番号は除く) */
function keyWords(key: string): string[] {
  const stagePass = /^(?:(?:this|self)\.)?pass\d+$/.test(key);
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    // 番号・版の語は除き、語の末尾の番号も除く(Password2 / DB_PASSWORD_2 / password_v2 / SMTP_PASS1)
    // (小文字の pass1 / pass2 だけのキー(this.pass1 / self.pass1 も)はコードの処理の段のことが多いため除かない)
    .map((word) => (/^v?\d+$/.test(word) ? "" : stagePass ? word : word.replace(/(?<=[a-z])\d+$/, "")))
    // 区切りのない語(DBPASSWORD / PGPASSWORD / sqlpwd)は末尾の password などを別の語にする(OLDPWD はシェルの変数)
    .flatMap((word) => {
      const joined = /^([a-z0-9]{2,}?)(password|passwd|pswd|pwd)$/.exec(word);
      return joined === null || word === "oldpwd" ? [word] : [joined[1] ?? "", joined[2] ?? ""];
    })
    .filter((word) => word !== "");
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
  return /[^\x00-\x7F]/.test(value) || /\S\s+\S/.test(value) || namesKey(key, value);
}

/** 値がキー名そのもの(最後の語・最後の 2 語・キー全体。大文字小文字・記号の差は問わない) */
function namesKey(key: string, value: string): boolean {
  const word = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return word !== "" && (lastKeyWords(key).includes(word) || word === key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * 閉じた引用符の後に続くコードの連結("Password=" & _ / "Password=" + pwd + "..." / "Password="+pwd; の後の行)
 * を属性の値と読み違えたもの。値の先頭が & / + (& は文字参照の &amp; などを除く)で、その後が空白・行継続か、
 * 値が行をまたぐか、連結の記号で終わるか、識別子の後に ) ; , が続くもの
 */
function isConcatenation(value: string): boolean {
  return (
    /^\s*[&+][\s_]/.test(value) ||
    (/^\s*(?:\+|&(?![A-Za-z]+;|#))/.test(value) &&
      (/[\r\n]/.test(value) || /[&+]\s*$/.test(value) || /^\s*[&+]\s*[A-Za-z_][\w.]*(?:\(\))?\s*[);,]/.test(value)))
  );
}

/** XML 属性形式の日本語キー: パスワード="..." など(非 VB ファイル用) */
const JP_ATTR_SECRET =
  /(パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号|ユーザー?(?:ID|ID|名)|ﾕｰｻﾞｰ?ID)(\s*[==]\s*")([^"]+)(")/g;

/**
 * 直前のコードが「変数 = 」で終わっているか(行継続 `_` 対応。型文字の付いた Dim strPwd$ = も)。
 * 文字列リテラルの直前コンテキスト判定に使う
 */
const ASSIGNMENT_TAIL = new RegExp(
  `([${IDENT_HEAD}][${IDENT_BODY}]*)[$%&!#@]?\\s*(?:As\\s+String\\s*)?[&+]?=\\s*(?:_\\s*)?(?:\\(\\s*(?:_\\s*)?)*$`,
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
  // 識別子の途中からは始めない(長い語のコメントで各位置から語の終わりまでを読み直さないように)
  // (.Password / 1.pwd のように . や数字から始まる語もそのまま識別子として読む)
  // VB の宣言(Dim strPwd As String = "..." / Const DB_PASSWORD As String = "...")・名前付き引数(password:="...")も
  // 値の "" は VB の文字列の中の " (Server=x;Password=""a;b"";)。型文字(Dim strPwd$ = "...")も
  `(?<![${IDENT_BODY}])([${IDENT_BODY}]+)([$%&!#@]?\\s*(?:[Aa][Ss]\\s+[${IDENT_HEAD}][${IDENT_BODY}]*(?:\\(\\))?\\s*)?:?=\\s*")((?:[^"\\r\\n]|"")+)("(?!"))`,
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
    (whole: string, key: string, eq: string, value: string, offset: number, source: string): string => {
      // コードの Python の接頭辞(username=b"..." / password = u'...')は残す(; の後の接続文字列の値は丸ごと伏せる)
      const code = !/;[ \t]*$/.test(source.slice(Math.max(0, offset - 20), offset));
      const prefix = code ? (/^([rRuUbBfF]{1,2})(?:"(?:[^"\\\r\n]|\\.)+"|'(?:[^'\\\r\n]|\\.)+')$/.exec(value)?.[1] ?? "") : "";
      // コードの接頭辞つきの文字列に続くメソッドの呼び出し(password = b"...".decode())は、接頭辞だけを値と読むため
      // ここでは伏せない(文字列はコードのリテラルとして伏せる)
      if (
        code &&
        ((/^[rRuUbBfF]{1,2}$/.test(value) && /^["']/.test(source.charAt(offset + whole.length))) || /^[rRuUbBfF]{1,2}'(?:[^'\\\r\n]|\\.)+'\./.test(value))
      ) {
        return whole;
      }
      const body = value.slice(prefix.length);
      const quote =
        prefix !== ""
          ? body.charAt(0)
          : CONNSTR_QUOTES.find(
              (q) => value.length > 2 * q.length && value.startsWith(q) && value.endsWith(q) && (q !== "'" || /^'(?:[^'\r\n]|'')+'$/.test(value)),
            );
      const inner = quote === undefined ? value : body.slice(quote.length, -quote.length);
      // 先に伏せた値(単一引用符の属性など)・書式の差し込みだけの値は伏せない
      if (inner.trim() === MASK || isPlaceholderOnly(inner)) {
        return whole;
      }
      findings.push({ line: toLine(offset), kind });
      return quote === undefined ? `${key}${eq}${MASK}` : `${key}${eq}${prefix}${quote}${MASK}${quote}`;
    };
  let result = text.replace(CONNSTR_SECRET, maskValue(KIND_PASSWORD));
  result = result.replace(CONNSTR_USER, maskValue(KIND_USER));
  result = result.replace(URL_USERINFO, (whole, head: string, value: string, offset: number) => {
    if (value.includes(MASK) || isUrlPlaceholder(value)) {
      return whole;
    }
    findings.push({ line: toLine(offset + head.length), kind: KIND_PASSWORD });
    return `${head}${MASK}@`;
  });
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
        // 真偽値(Dim savePassword As String = "True")は伏せない(連結で続くリテラルは値の続きとして伏せる)
        if (/^(?:true|false)$/i.test(inner.trim())) {
          emit(`"${inner}"`);
        } else {
          findings.push({ line: lineOf(content, i), kind });
          emit(`"${MASK}"`);
        }
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
    // 真偽値・差し込みだけの値は伏せない。設定のキーは字句解析の token などではないため、token / credentials の
    // キーも値によらず伏せる(空白を含む値はパスフレーズのことがあるため、表示の文言の例外も使わない)
    if (kind === undefined || value === undefined || value === MASK || isNonSecretValue(value)) {
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
        (resource && kind === KIND_PASSWORD && !isSecretPair(name ?? "", inner)) ||
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
  // Dockerfile の ENV / ARG(KEY=value を空白で区切って並べられ、行末の \ で次の行へ続く)
  result = result.replace(DOCKER_ENV, (whole, lead: string, body: string, offset: number) => {
    let kindFound: string | undefined;
    const pairs = body.replace(DOCKER_PAIR, (pair, k: string, e: string, v: string) => {
      const shown = maskedEnvValue(k, v, false);
      if (shown === undefined) {
        return pair;
      }
      kindFound ??= kindForConfigKey(k);
      return `${k}${e}${shown}`;
    });
    if (kindFound !== undefined) {
      findings.push({ line: lineOf(result, offset), kind: kindFound });
    }
    return `${lead}${pairs}`;
  });
  result = result.replace(ENV_LINE, (whole, lead: string, key: string, eq: string, line: string, offset: number) => {
    const kind = kindForConfigKey(key);
    // - "KEY=value" / - 'KEY=value' の閉じる引用符は値に含めない(YAML の文字列なので # もコメントではない)
    const leadQuote = /["']$/.exec(lead)?.[0] ?? "";
    const closing = leadQuote === "" ? "" : ((leadQuote === '"' ? /"[ \t]*(?:[ \t]#[^\r\n]*)?$/ : /'[ \t]*(?:[ \t]#[^\r\n]*)?$/).exec(line)?.[0] ?? "");
    const rest = line.slice(0, line.length - closing.length);
    const trimmed = rest.trim();
    // 空白の後の # からは行末のコメント(.env)。引用符で囲んだ値は閉じる引用符の後のコメントだけ
    // (引用符の中の # は値のうち。閉じていない引用符の値はコメントを除かない)
    const quotedHead = /^["']/.test(trimmed) ? /^(["'])(?:(?!\1)[^\r\n])*\1(?=[ \t]+#|[ \t]*$)/.exec(trimmed) : null;
    const value =
      leadQuote !== "" || /^["']/.test(trimmed)
        ? (quotedHead?.[0] ?? trimmed)
        : trimmed.includes("#")
          ? trimmed.replace(/(?<![ \t])[ \t]+#.*$/, "")
          : trimmed;
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
      isShellVariable(head) ||
      // 表示の文言(.properties の password=Enter your password など)とみなすのは行頭のキーの行だけ
      // (export / compose の一覧の値の空白は値のうち)
      (kind === KIND_PASSWORD ? !isSecretPair(key, head, lead === "") : isPlaceholderOnly(head))
    ) {
      return whole;
    }
    findings.push({ line: lineOf(result, offset), kind });
    const at = rest.indexOf(value);
    const shown = quoted ? `${quote}${MASK}${quote}` : MASK;
    return `${lead}${key}${eq}${rest.slice(0, at)}${shown}${rest.slice(at + value.length)}${closing}`;
  });
  // バッチファイルの set(値の空白も値のうちなので表示の文言とはみなさない)。SQL の SET を飛ばしたときと、文字列・
  // 括弧の中で値を途中で終えたときは、その後ろから続けて探す(同じ行の後ろの set も読む)
  {
    const source = result;
    const lineHead = lineHeadScanner(source);
    const pattern = new RegExp(BATCH_SET.source, BATCH_SET.flags);
    let out = "";
    let last = 0;
    for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
      const offset = m.index;
      const quote = m[2] ?? "";
      const key = m[3] ?? "";
      const valueStart = offset + m[0].length;
      const before = lineHead(offset);
      // SQL の UPDATE 表 [別名] SET col=...(コードの文字列の中のものも)と、値が列名に対応するバインド変数
      // (@name / :name / ?)の SET(UPDATE の次の行の SET col=:col, ...)はバッチの set ではない
      if (
        /(?:\b(?:then|do)[ \t]+update[ \t]+|\bupdate[ \t]+[\w.\[\]"`${}]+(?:[ \t]+(?:as[ \t]+)?(?!set\b)\w+)?[ \t]+)$/i.test(source.slice(Math.max(before.lineStart, offset - 300), offset)) ||
        isBindMarkerFor(key, source.slice(valueStart, valueStart + 300), source.slice(Math.max(0, offset - 300), offset))
      ) {
        pattern.lastIndex = valueStart;
        continue;
      }
      const end = batchValueEnd(source, valueStart, quote, quote === "" && before.quotes % 2 === 1, quote === "" && before.depth > 0);
      pattern.lastIndex = Math.max(end, valueStart);
      const value = source.slice(valueStart, end);
      // 引用符で囲んだ値の後ろの ; / ,(SQL の SET PASSWORD='...';)は値に含めない
      const trimmed = value.trim();
      const trail = /^(["'])[^\r\n]*\1([;,]+)$/.exec(trimmed)?.[2] ?? "";
      const inner = trimmed.slice(0, trimmed.length - trail.length);
      // 先に伏せた値(接続文字列の形の SET PASSWORD='...'; は [MASKED]; になっている)は伏せ直さない
      const shown = inner.startsWith(MASK) ? undefined : maskedEnvValue(key, inner, false, true);
      if (shown === undefined) {
        continue;
      }
      findings.push({ line: lineOf(source, offset), kind: kindForConfigKey(key) ?? KIND_PASSWORD });
      const at = value.indexOf(inner);
      out += `${source.slice(last, valueStart)}${value.slice(0, at)}${shown}`;
      last = valueStart + at + inner.length;
    }
    result = out + source.slice(last);
  }
  // コマンドの引数の環境変数(docker run -e DB_PASSWORD=...)
  result = result.replace(SHELL_ENV_ARG, (whole, flag: string, arg: string, offset: number) => {
    const quote = /^["']/.test(arg) ? arg.charAt(0) : "";
    const body = quote === "" ? arg : arg.slice(1, -1);
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]*)$/.exec(body);
    const key = pair?.[1] ?? "";
    const shown = pair === null ? undefined : maskedEnvValue(key, pair[2] ?? "", false, true);
    if (shown === undefined) {
      return whole;
    }
    findings.push({ line: lineOf(result, offset), kind: kindForConfigKey(key) ?? KIND_PASSWORD });
    return `${flag}${quote}${key}=${shown}${quote}`;
  });
  // パスワードを引数で渡すコマンド(sqlcmd -P ... / mysql -p... / net use \\srv\share ... / schtasks /RP ...)
  result = maskCliArgs(result, findings);
  // XML 属性形式(値が引用符で囲まれるため接続文字列パターンでは拾えない)
  for (const regex of [ATTR_SECRET, ATTR_SECRET_SINGLE]) {
    result = result.replace(
      regex,
      (whole, key: string, eq: string, value: string, closeQuote: string, offset: number) => {
        // 値が空白・書式の差し込みだけのもの・先に伏せたもの、閉じた引用符の後のコードの連結("Password=" & _ の
        // 次の行の " まで / "Password="+password; の後の次の行の " まで)は伏せない
        if (value.trim() === "" || value === MASK || isPlaceholderOnly(value) || isConcatenation(value)) {
          return whole;
        }
        // バッチファイルの set "KEY=" の " は値の引用符ではない(空の値の set "DB_PASSWORD=" の後の行まで読まない)
        const lineHead = /[^\r\n]*$/.exec(result.slice(Math.max(0, offset - 200), offset))?.[0] ?? "";
        if (/(?:^|[ \t@(&|])set[ \t]+"[A-Za-z0-9_.-]*$/i.test(lineHead)) {
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
  const maskKeyLiteral = (whole: string, key: string, sep: string, literal: string, offset: number): string => {
    const name = /^["']/.test(key) ? key.slice(1, -1) : key;
    // : だけの区切りはオブジェクト・辞書・行頭(コメントの次の行・YAML も)のキーだけ(三項演算子の cond ? "password" : "text" を除く)
    const before = result.slice(Math.max(0, offset - 200), offset);
    if (sep.includes(":") && !sep.includes("=")) {
      // 行頭は YAML のリストの項目(- password: "...")も。前の行が ? で終わり、: の前に空白があれば複数行の
      // 三項演算子とみなす(? で終わるコメントの行は除く)
      const ternary =
        /^\s+:/.test(sep) &&
        /\?[ \t]*\r?\n[ \t]*$/.test(before) &&
        !/(?:#|\/\/)[^\r\n]*\?[ \t]*\r?\n[ \t]*$/.test(before);
      const lineStart =
        /[{,[(][ \t]*$/.test(before) ||
        (/\n[ \t]*(?:-[ \t]+)?$/.test(before) && !ternary) ||
        (offset <= 200 && /^[ \t]*(?:-[ \t]+)?$/.test(before));
      // TS の型の文字列リテラルの合併(token: "a" | "b")は値ではない
      const union = /^[ \t]*\|(?!\|)/.test(result.slice(offset + whole.length, offset + whole.length + 20));
      if (!lineStart || union) {
        return whole;
      }
    }
    const prefix = /^[^"']*/.exec(literal)?.[0] ?? "";
    const quote = literal.charAt(prefix.length);
    if (!isSecretPair(name, literal.slice(prefix.length + 1, -1))) {
      return whole;
    }
    findings.push({ line: lineOf(result, offset), kind: KIND_PASSWORD });
    return `${key}${sep}${prefix}${quote}${MASK}${quote}`;
  };
  // キーと文字列の値("password": "..." / dbPassword = "..." / { apiKey: '...' } / password: string = "...")
  result = result.replace(KEY_LITERAL, maskKeyLiteral);
  // : の後に空白のない注釈は、token などのキーでは型が文字列のときだけ(last_synced_token:label="..." は書式指定)
  result = result.replace(KEY_LITERAL_TYPED, (whole: string, key: string, sep: string, literal: string, offset: number) =>
    /:[^ \t]/.test(sep) && !hasStrongSecretWord(key) && !/:(?:str|string|String|bytes|SecretStr|Optional\b)/.test(sep)
      ? whole
      : maskKeyLiteral(whole, key, sep, literal, offset),
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
  if (options.language !== undefined && !options.vbSource) {
    return maskLanguageSource(content, options.strict ?? true, options.language);
  }
  const findings: MaskFinding[] = [];
  const strict = options.strict ?? true;
  let result = options.vbSource
    ? maskVbSource(content, findings, strict)
    : maskGenericText(content, findings, strict);
  if (options.vbSource) {
    // VB の文字列の中のコマンド(Shell("net use ...") / Process.Start("sqlcmd.exe", "-S srv -P ..."))
    result = maskCliArgs(result, findings);
  }

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
// 言語の分かるソースの伏せ方 (設計書 §25.7)
// ---------------------------------------------------------------------------

const QUOTE_CHARS = new Set(['"', "'", "`"]);

/**
 * 汎用テキストとして伏せた範囲のうち、リテラル (文字列の中身・コメント・数値) の中の部分だけを伏せる。
 * コードの部分は戻す。ただし次のコードの部分は伏せたままにする (字句解析を読み違えたときに値を出さない):
 * - 読み違えの恐れのある行 (1 行で閉じる文字列が閉じていない行など) の中
 * - 前後が引用符で挟まれている (文字列の中身に見える)
 * - その部分だけを汎用テキストとして伏せても伏せる (トークンの形式・高エントロピーなど)
 * 伏せた範囲を元の位置に対応づけられなければ、汎用テキストとしての結果をそのまま返す
 */
function maskLanguageSource(content: string, strict: boolean, language: SourceLanguage): MaskResult {
  const generic = maskCredentials(content, { vbSource: false, strict });
  if (generic.content === content) return generic;
  const spans = spansOfMasked(content, generic.content);
  if (spans === null) return generic;
  const lexed = literalRegions(content, language);
  // 読み違えの恐れのある行は全体をリテラルとみなす
  const literal: Array<[number, number]> = [...lexed.regions];
  if (lexed.uncertainLines.size > 0) {
    let lineStart = 0;
    let line = 0;
    while (lineStart <= content.length) {
      const newline = content.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? content.length : newline;
      if (lexed.uncertainLines.has(line)) literal.push([lineStart, lineEnd]);
      if (newline < 0) break;
      lineStart = newline + 1;
      line += 1;
    }
    literal.sort((a, b) => a[0] - b[0]);
  }
  const pieces: Array<[number, number]> = [];
  const keepCode = (from: number, to: number): boolean => {
    const piece = content.slice(from, to);
    if (piece.trim() === "") return false;
    if (QUOTE_CHARS.has(content.charAt(from - 1)) && QUOTE_CHARS.has(content.charAt(to))) return true;
    return maskCredentials(piece, { vbSource: false, strict }).content !== piece;
  };
  const push = (from: number, to: number): void => {
    if (to > from && content.slice(from, to).trim() !== "") pieces.push([from, to]);
  };
  let r = 0;
  for (const span of spans) {
    while (r < literal.length && (literal[r]?.[1] ?? 0) <= span.start) r += 1;
    let cursor = span.start;
    for (let k = r; k < literal.length; k++) {
      const region = literal[k];
      if (region === undefined || region[0] >= span.end) break;
      const from = Math.max(region[0], span.start);
      const to = Math.min(region[1], span.end);
      if (from > cursor) {
        if (keepCode(cursor, from)) push(cursor, from);
      }
      if (to > Math.max(from, cursor)) push(Math.max(from, cursor), to);
      cursor = Math.max(cursor, to);
    }
    if (cursor < span.end && keepCode(cursor, span.end)) push(cursor, span.end);
  }
  // 隣り合う部分は 1 つの伏せ字にする
  const merged: Array<[number, number]> = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && piece[0] <= last[1]) last[1] = Math.max(last[1], piece[1]);
    else merged.push([piece[0], piece[1]]);
  }
  let out = "";
  let cursor = 0;
  const keptLines = new Set<number>();
  for (const [from, to] of merged) {
    const value = content.slice(from, to);
    // 複数行の値 (秘密鍵の本文など) は汎用テキストと同じく「改行 + 伏せ字 + 改行」にする
    const block = value.length > 1 && value.startsWith("\n") && value.endsWith("\n");
    out += content.slice(cursor, from) + (block ? `\n${MASK}\n` : MASK);
    cursor = to;
    const first = lineOf(content, from);
    const last = lineOf(content, Math.max(from, to - 1));
    for (let line = first; line <= last; line++) keptLines.add(line);
  }
  out += content.slice(cursor);
  lineIndexText = undefined;
  lineIndexBreaks = [];
  if (merged.length === 0) return { content, findings: [] };
  const findings = generic.findings.filter((finding) => keptLines.has(finding.line));
  return { content: out, findings: findings.length > 0 ? findings : generic.findings };
}

// ---------------------------------------------------------------------------
// 伏せた表示 (行の位置を保つ)。petari build のエラーの抜粋と失敗レポートの抜粋で使う
// ---------------------------------------------------------------------------

/** パックで置き換える伏せ字 */
export const MASK_TOKEN = MASK;

export function hasMaskToken(line: string): boolean {
  return line.includes(MASK);
}

/** 伏せ方 (パックが取り得る組み合わせ) */
interface MaskMode {
  vbSource: boolean;
  strict: boolean;
  language?: SourceLanguage | undefined;
}

/** 伏せた範囲 (元の文字列の位置。tokens は隣り合った伏せ字をまとめた数) */
interface MaskSpan {
  start: number;
  end: number;
  tokens: number;
}

/**
 * パックが使い得る伏せ方。.vb は VB として伏せるのが通常だが、generic 構成の追加ディレクトリでは
 * 汎用テキストとして伏せる。strict は --no-strict-mask で切られる
 */
function maskModes(path: string, stricts: boolean[]): MaskMode[] {
  const vbs = /\.vb$/i.test(path) ? [true, false] : [false];
  const modes: MaskMode[] = vbs.flatMap((vbSource) => stricts.map((strict) => ({ vbSource, strict })));
  // 言語の分かるソースは、言語ごとの伏せ方 (petari pack) と汎用テキストの伏せ方 (旧 slnmix のパック) の両方
  const language = sourceLanguageOf(path);
  if (language !== undefined) {
    modes.push(...stricts.map((strict) => ({ vbSource: false, strict, language })));
  }
  return modes;
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
  return spansOfMasked(text, maskCredentials(text, mode).content);
}

/** 伏せた結果 (maskedContent) から、伏せた範囲を元の文字列 (text) の位置で求める。対応づけられなければ null */
function spansOfMasked(text: string, maskedContent: string): MaskSpan[] | null {
  const masked = maskedContent.replace(
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
   * 複数行にまたがる値 (秘密鍵の本文・複数行の属性値) の一部を伏せた行。パックでは
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
   * VB のソースとして伏せるか。パックでの伏せ方が分かっているとき (petari build) に指定する。
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
 * パックが取り得るどの伏せ方 (.vb を VB として / 汎用テキストとして、strict の有無) でも伏せられる範囲を
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
 * 照合と伏せ字の復元に使う伏せた表示。パックが取り得る伏せ方ごとと、失敗レポート・
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
 * (数えるのは戻した行ごと。伏せ方の違う 2 つの表示から同じ行を書いても 2 回と数える。キーが別の行にある `<value>[MASKED]</value>`・INI のセクションや If の分岐の中の `pwd = [MASKED]` を写すと、
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
  // 範囲で、元に戻した行 (前後の空白を除く) ごとの元の行の位置。伏せ方が違うと同じ行が別の表示になるため、
  // 表示ではなく戻した行で数える (伏せ方の違う 2 つの表示から同じ行を 2 回書く回答を「写した」と判定するため)
  const sourceLines = new Map<string, Set<number>>();
  let hasRealValue = false;
  for (const view of views) {
    for (let i = Math.max(0, range.from); i < Math.min(range.to, view.length); i++) {
      const v = view[i];
      if (v === undefined || !hasMaskToken(v.text)) continue;
      if (v.values === null || v.values.some((value) => value !== MASK)) hasRealValue = true;
      const key = v.text.trim();
      if (v.values !== null && v.values.length === v.text.split(MASK).length - 1) {
        const original = fillMaskTokens(key, v.values);
        sourceLines.set(original, (sourceLines.get(original) ?? new Set<number>()).add(i));
      }
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
  // 実際の値を戻す行の、戻した行 (前後の空白を除く) ごとの書く行
  const restoredAt = new Map<string, string[]>();
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
    if (only.values.some((value) => value !== MASK)) {
      const original = fillMaskTokens(line.trim(), only.values);
      restoredAt.set(original, [...(restoredAt.get(original) ?? []), line]);
    }
    out.push(fillMaskTokens(line, only.values));
    sources.push(only.source);
    // 実ファイルにもともと [MASKED] という文字がある行は、その文字に戻る (数えない)
    restored += only.values.filter((value) => value !== MASK).length;
  }
  // 実際の値を伏せた行を元より多く書くなら、写して足した行がある (別のキー・別の場所に同じ値を書き得る)
  for (const [original, at] of restoredAt) {
    if (at.length > (sourceLines.get(original)?.size ?? 0)) {
      for (const line of at) failures.push({ line, reason: "copied" });
    }
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
