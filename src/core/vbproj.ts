/**
 * 旧スタイル .vbproj への Compile 項目登録 (設計書 §11.1 P1-a)。
 *
 * 旧スタイル .vbproj は <Compile Include> に載っていないファイルをコンパイルしない。
 * AI にこれをやらせるとパックに .vbproj 本体がなく SEARCH が一致しないため、
 * petari が機械的に登録する。実行時依存ゼロの方針により XML パーサは使わず、
 * 行単位の正規表現処理で <ItemGroup> / <Compile Include="..."> を扱う。
 *
 * 純粋関数のみ (ファイル I/O なし)。行配列 in → 挿入位置と挿入行 out。
 * 挿入行以外には触れないため、呼び出し側は既存の行単位ドキュメント (encoding.ts) に
 * 挿入行だけを差し込めばエンコーディング・改行・BOM が保たれる (§8)。
 *
 * 整形が特殊な .vbproj (1 行に複数要素、CDATA、閉じタグ欠落等) は「登録できない形式」として
 * 未登録扱いにし、壊さない。
 */

export interface VbprojRegisterOptions {
  /** <SubType> の値 (Form / UserControl)。省略時は付けない */
  subType?: string;
  /** <DependentUpon> の値 (親ファイル名)。省略時は付けない */
  dependentUpon?: string;
}

export type VbprojRegisterResult =
  /** 登録する: lines[at] の直前に inserted を挿入する */
  | { status: "insert"; at: number; inserted: string[] }
  /** 既に同じ Include が登録済み (冪等) */
  | { status: "registered" }
  /** SDK スタイル (既定グロブでコンパイルされるため登録不要) */
  | { status: "sdk-style" }
  /** 登録できない形式 (壊さないため何もしない) */
  | { status: "unsupported"; reason: string };

/** `<Project Sdk="...">` または Sdk.props の Import があれば SDK スタイル */
export function isSdkStyleVbproj(lines: readonly string[]): boolean {
  const text = lines.join("\n");
  if (/<Project\b[^>]*\bSdk\s*=/i.test(text)) return true;
  if (/<Import\b[^>]*\bProject\s*=\s*"[^"]*Sdk\.props"/i.test(text)) return true;
  return /<Sdk\b[^>]*\bName\s*=/i.test(text);
}

/** Include 属性値の比較用正規化 (区切り記号と大文字小文字の差は同じファイルとみなす) */
function normalizeInclude(include: string): string {
  return unescapeXml(include).replace(/\//g, "\\").toLowerCase();
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const RE_ITEMGROUP_OPEN = /^(\s*)<ItemGroup(\s[^<>]*)?>\s*$/i;
const RE_ITEMGROUP_CLOSE = /^\s*<\/ItemGroup>\s*$/i;
const RE_COMPILE_SELF = /^(\s*)<Compile\s[^<>]*\/>\s*$/i;
const RE_COMPILE_OPEN = /^(\s*)<Compile\s[^<>]*[^/]>\s*$/i;
const RE_COMPILE_CLOSE = /^\s*<\/Compile>\s*$/i;
const RE_COMPILE_INCLUDE = /<Compile\s[^<>]*\bInclude\s*=\s*"([^"]*)"/i;
const RE_PROJECT_CLOSE = /^\s*<\/Project>\s*$/i;

interface ItemGroupInfo {
  open: number;
  close: number;
  conditional: boolean;
  /** グループ内の最初の Compile 行 (self-closing または開始タグ) */
  firstCompile: number | null;
  indent: string;
}

/** 行構造を走査し ItemGroup の一覧を返す。形式が想定外なら文字列で理由を返す */
function scanItemGroups(lines: readonly string[]): ItemGroupInfo[] | string {
  const groups: ItemGroupInfo[] = [];
  let current: ItemGroupInfo | null = null;
  let openCompile = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.includes("<![CDATA[")) return "CDATA を含む";
    const hasGroupOpen = /<ItemGroup\b/i.test(line);
    const hasGroupClose = /<\/ItemGroup>/i.test(line);
    const hasCompile = /<Compile\b/i.test(line);
    const hasCompileClose = /<\/Compile>/i.test(line);
    if (hasGroupOpen) {
      const m = RE_ITEMGROUP_OPEN.exec(line);
      if (m === null || hasGroupClose || hasCompile) return `${i + 1} 行目: <ItemGroup> が単独の行ではない`;
      if (current !== null) return `${i + 1} 行目: <ItemGroup> が入れ子になっている`;
      current = {
        open: i,
        close: -1,
        conditional: /\bCondition\s*=/i.test(m[2] ?? ""),
        firstCompile: null,
        indent: m[1] ?? "",
      };
      continue;
    }
    if (hasGroupClose) {
      if (!RE_ITEMGROUP_CLOSE.test(line)) return `${i + 1} 行目: </ItemGroup> が単独の行ではない`;
      if (current === null) return `${i + 1} 行目: 対応する <ItemGroup> がない`;
      if (openCompile) return `${i + 1} 行目: <Compile> が閉じられていない`;
      current.close = i;
      groups.push(current);
      current = null;
      continue;
    }
    if (hasCompile) {
      if (current === null) return `${i + 1} 行目: <Compile> が <ItemGroup> の外にある`;
      if (openCompile) return `${i + 1} 行目: <Compile> が閉じられていない`;
      if (RE_COMPILE_SELF.test(line)) {
        if (current.firstCompile === null) current.firstCompile = i;
        continue;
      }
      if (RE_COMPILE_OPEN.test(line) && !hasCompileClose) {
        if (current.firstCompile === null) current.firstCompile = i;
        openCompile = true;
        continue;
      }
      return `${i + 1} 行目: <Compile> 要素が 1 行 1 要素になっていない`;
    }
    if (hasCompileClose) {
      if (!openCompile || !RE_COMPILE_CLOSE.test(line)) return `${i + 1} 行目: </Compile> の位置が不正`;
      openCompile = false;
    }
  }
  if (current !== null) return "</ItemGroup> が欠けている";
  return groups;
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

/**
 * 既存の複数行 <Compile> から子要素のインデント増分を推定する。なければ 2 スペース
 * (Visual Studio の既定整形: `  <ItemGroup>` / `    <Compile>` / `      <SubType>`)
 */
function childIndentDelta(lines: readonly string[]): string {
  for (let i = 0; i < lines.length - 1; i++) {
    const m = RE_COMPILE_OPEN.exec(lines[i] as string);
    if (m === null) continue;
    const next = lines[i + 1] as string;
    if (RE_COMPILE_CLOSE.test(next)) continue;
    const child = leadingWhitespace(next);
    const parent = m[1] ?? "";
    if (child.startsWith(parent) && child.length > parent.length) return child.slice(parent.length);
  }
  return "  ";
}

/**
 * relInclude (.vbproj からの相対パス・`\` 区切り) を Compile 項目として登録する位置と行を返す。
 * 判定順: SDK スタイル → 登録済み → 形式検査 → 挿入位置計算。
 */
export function registerCompileItem(
  lines: readonly string[],
  relInclude: string,
  opts: VbprojRegisterOptions = {},
): VbprojRegisterResult {
  if (isSdkStyleVbproj(lines)) return { status: "sdk-style" };

  const wanted = normalizeInclude(relInclude);
  for (const line of lines) {
    const m = RE_COMPILE_INCLUDE.exec(line);
    if (m !== null && normalizeInclude(m[1] ?? "") === wanted) return { status: "registered" };
  }

  if (!lines.some((l) => /<Project\b/i.test(l))) {
    return { status: "unsupported", reason: "<Project> 要素が見つからない" };
  }
  const groups = scanItemGroups(lines);
  if (typeof groups === "string") return { status: "unsupported", reason: groups };

  const delta = childIndentDelta(lines);
  const item = (indent: string): string[] => {
    const include = escapeXmlAttr(relInclude);
    const children: string[] = [];
    if (opts.subType !== undefined) children.push(`<SubType>${escapeXmlText(opts.subType)}</SubType>`);
    if (opts.dependentUpon !== undefined) {
      children.push(`<DependentUpon>${escapeXmlText(opts.dependentUpon)}</DependentUpon>`);
    }
    if (children.length === 0) return [`${indent}<Compile Include="${include}" />`];
    return [
      `${indent}<Compile Include="${include}">`,
      ...children.map((c) => `${indent}${delta}${c}`),
      `${indent}</Compile>`,
    ];
  };

  // Compile 項目を含む最初の (無条件の) ItemGroup の末尾に追加する
  const target = groups.find((g) => g.firstCompile !== null && !g.conditional);
  if (target !== undefined) {
    const indent = leadingWhitespace(lines[target.firstCompile as number] as string);
    return { status: "insert", at: target.close, inserted: item(indent) };
  }

  // なければ最後の ItemGroup の後に新しい ItemGroup を作る (ItemGroup が皆無なら </Project> の直前)
  const last = groups[groups.length - 1];
  const projectClose = lines.findIndex((l) => RE_PROJECT_CLOSE.test(l));
  if (last === undefined && projectClose < 0) {
    return { status: "unsupported", reason: "</Project> が見つからない" };
  }
  const groupIndent = last?.indent ?? "  ";
  const at = last !== undefined ? last.close + 1 : projectClose;
  return {
    status: "insert",
    at,
    inserted: [`${groupIndent}<ItemGroup>`, ...item(groupIndent + delta), `${groupIndent}</ItemGroup>`],
  };
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** テスト・表示用: 挿入結果を行配列に反映する */
export function applyInsertion(
  lines: readonly string[],
  result: { at: number; inserted: string[] },
): string[] {
  return [...lines.slice(0, result.at), ...result.inserted, ...lines.slice(result.at)];
}

const RE_INHERITS =
  /^\s*Inherits\s+(?:(?:System\.)?Windows\.Forms\.)?(Form|UserControl)\s*(?:'.*)?$/i;

/** 新規 .vb の内容から <SubType> を推定する (Inherits Form / UserControl)。該当なしは undefined */
export function detectSubType(contentLines: readonly string[]): string | undefined {
  for (const line of contentLines) {
    const m = RE_INHERITS.exec(line);
    if (m === null) continue;
    const name = (m[1] as string).toLowerCase();
    return name === "form" ? "Form" : "UserControl";
  }
  return undefined;
}

/** `X.Designer.vb` なら親ファイル名 `X.vb` を返す (大文字小文字は区別しない)。それ以外は null */
export function designerParentName(fileName: string): string | null {
  const m = /^(.+)\.designer\.vb$/i.exec(fileName);
  return m === null ? null : `${m[1] as string}.vb`;
}

/** ルート相対パス (/ 区切り) を .vbproj のディレクトリからの相対 Include (\ 区切り) にする */
export function toIncludePath(vbprojDir: string, filePath: string): string {
  const base = vbprojDir === "" ? [] : vbprojDir.split("/");
  const target = filePath.split("/");
  let common = 0;
  while (common < base.length && common < target.length && base[common] === target[common]) common++;
  const ups = base.slice(common).map(() => "..");
  return [...ups, ...target.slice(common)].join("\\");
}
