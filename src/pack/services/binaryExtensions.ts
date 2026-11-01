/**
 * 内容を含めないバイナリ系拡張子(小文字)。
 * repomixExporter(プロジェクト項目)と extraRootsCollector(追加ルート)で共用する。
 */

export const BINARY_EXTENSIONS: readonly string[] = [
  ".dll",
  ".exe",
  ".pdb",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".pdf",
  ".xls",
  ".xlsx",
  ".doc",
  ".docx",
];

/** ファイル名の拡張子(小文字)。なければ空文字 */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

export function isBinaryExtension(fileName: string): boolean {
  return BINARY_EXTENSIONS.includes(extensionOf(fileName));
}
