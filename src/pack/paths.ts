/**
 * Windows パス前提のパス解決ユーティリティ。
 * vbprojParser と slnParser で共用する。
 */

import * as path from "node:path";

/** ドライブ絶対パス(C:\ など)または UNC(\\server\...) */
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/**
 * .vbproj / .sln に書かれたパスを絶対パスへ解決する。
 * - ドライブ絶対パス・UNC は実行環境によらず Windows パスとして正規化のみ行う
 * - 相対パスは baseDir 基準。`\` 区切りは実行環境の区切りへ変換する
 *   (Mac での開発・テストと Windows での実利用の両方で動かすため)
 */
export function resolveWindowsPath(value: string, baseDir: string): string {
  if (WINDOWS_ABSOLUTE.test(value)) {
    return path.win32.normalize(value);
  }
  const platformRelative = value.split(/[\\/]/).join(path.sep);
  return path.resolve(baseDir, platformRelative);
}
