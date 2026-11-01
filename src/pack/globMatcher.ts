/**
 * MSBuild のワイルドカード(`**` / `*` / `?`)の最小限の一致判定。
 *
 * SDK スタイル .vbproj の既定グロブ展開、`<Compile Remove="...">` /
 * `<Compile Update="...">` / `DefaultItemExcludes` の解釈、および
 * slnmix.config.json の extraRoots(include / exclude)に使う。
 * MSBuild 式 $()/@()/%() は扱わない(呼び出し側で未解決として扱う)。
 *
 * - パターン・対象パスとも `\` と `/` を同一視し、大文字小文字は区別しない
 *   (Windows のファイルシステム前提)
 * - `**` は 0 個以上のディレクトリ、`*` はセグメント内の任意の文字列、
 *   `?` はセグメント内の 1 文字
 * - 対象パスはプロジェクトディレクトリ基準の相対パス(先頭の `./` は無視)
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** パス区切りを `/` に揃え、先頭の `./` を落とす */
export function normalizeGlobPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
}

/** ブレース `{a,b}` を含まない部分をパターン→正規表現ソースへ変換する */
function convertPlain(text: string): string {
  let source = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "*" && text[i + 1] === "*") {
      // `**/` は 0 個以上のディレクトリ、末尾や `/` が続かない `**` は何でも
      if (text[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 3;
      } else {
        source += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(ch);
    }
    i += 1;
  }
  return source;
}

/**
 * パターンを正規表現へ変換する。`{ts,tsx}` のようなブレース(入れ子なし)は
 * 選択肢として展開する(extraRoots の include 指定用)。
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPath(pattern.trim());
  let source = "";
  let rest = normalized;
  while (rest.length > 0) {
    const open = rest.indexOf("{");
    const close = open >= 0 ? rest.indexOf("}", open) : -1;
    if (open < 0 || close < 0) {
      source += convertPlain(rest);
      break;
    }
    source += convertPlain(rest.slice(0, open));
    const alternatives = rest
      .slice(open + 1, close)
      .split(",")
      .map((alt) => convertPlain(alt.trim()));
    source += `(?:${alternatives.join("|")})`;
    rest = rest.slice(close + 1);
  }
  return new RegExp(`^${source}$`, "i");
}

/** relativePath がパターンに一致するか(`\` / `/` 混在可) */
export function globMatches(pattern: string, relativePath: string): boolean {
  return globToRegExp(pattern).test(normalizeGlobPath(relativePath));
}
