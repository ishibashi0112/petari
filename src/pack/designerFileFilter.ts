/**
 * --include-designer-file のパターン照合(CLI 固有・共有コアへの同期は不要)。
 *
 * Designer 関連ファイルのうち原文を含めるものを名前で選ぶための照合器。
 * 共有コア(repomixExporter)の includeSensitive へ述語として渡す。
 *
 * 照合ルール:
 * - 大文字小文字は区別しない(Windows のファイル名前提)
 * - `*` は任意の文字列(パス区切りを含む)にマッチする
 * - パターンの `/` は `\` として扱う(Mac / シェルでの入力しやすさのため)
 * - 論理パス全体(例: `Forms\OrderForm.Designer.vb`)とファイル名
 *   (例: `OrderForm.Designer.vb`)のどちらかに全体一致すれば含める
 */

export function buildDesignerFileMatcher(
  patterns: readonly string[],
): (logicalPath: string) => boolean {
  const regexes = patterns.map(patternToRegex);
  return (logicalPath) => {
    const fileName = logicalPath.split("\\").pop() ?? logicalPath;
    return regexes.some(
      (regex) => regex.test(fileName) || regex.test(logicalPath),
    );
  };
}

/** `*` のみをワイルドカードとして解釈し、全体一致の正規表現へ変換する */
function patternToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\//g, "\\");
  const escaped = normalized
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}
