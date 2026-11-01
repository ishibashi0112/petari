/**
 * ルート(物理パス・設定ファイル・protocol.md / procedure.md・docs/・出力先の基準)を決める。
 *
 * 従来はルート = 入力(.sln / .vbproj)のあるディレクトリに固定していたが、
 * web + dotnet を分けた構成(例: webview2-bridge の雛形は `dotnet/MyApp.sln`)では
 * `web/` `contract/` `e2e/` がルート外になり、petari のルート(.git の場所)とも
 * ずれる。そこで次の順で決める(決定ログ 2026-09-22):
 *
 *   1. `--root <dir>` の明示指定(入力はその配下にあること)
 *   2. 入力のディレクトリから上に向かって `slnmix.config.json` を探し、最初に
 *      見つかったディレクトリ。`.git` のあるディレクトリ(リポジトリの境界)より
 *      上には行かない。入力のディレクトリ自身に設定があれば従来と同じ
 *   3. どちらもなければ入力のディレクトリ(従来どおり)
 *
 * `.git` を自動で辿る方式は採らない。.sln がリポジトリ直下にない既存プロジェクトの
 * 出力が黙って変わるため。設定ファイルを置いた人だけが変わる、という明示の形にする。
 *
 * 純粋関数(ファイルシステムは deps 注入)。
 */

import * as path from "node:path";
import { CONFIG_FILE_NAME } from "./slnmixConfig.ts";

export interface RootResolverDeps {
  isDirectory(absolutePath: string): boolean;
  isFile(absolutePath: string): boolean;
  /** `.git`(ディレクトリまたはファイル)があるか。無ければ境界扱いしない */
  exists(absolutePath: string): boolean;
}

export type RootReason = "explicit" | "config" | "target";

export type RootResolution =
  | { kind: "root"; rootDir: string; reason: RootReason }
  | { kind: "error"; message: string };

/** child が parent と同じか配下か(大文字小文字は区別しない: Windows のパス前提) */
export function isWithinDirectory(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") {
    return true;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * @param targetPath 入力(.sln / .vbproj)の絶対パス
 * @param explicitRoot `--root` の値(未指定なら undefined)
 * @param cwd `--root` を相対指定したときの基準
 */
export function resolveRoot(
  targetPath: string,
  explicitRoot: string | undefined,
  cwd: string,
  deps: RootResolverDeps,
): RootResolution {
  const targetDir = path.dirname(targetPath);
  if (explicitRoot !== undefined) {
    const rootDir = path.resolve(cwd, explicitRoot);
    if (!deps.isDirectory(rootDir)) {
      return { kind: "error", message: `--root のディレクトリがありません: ${rootDir}` };
    }
    if (!isWithinDirectory(rootDir, targetDir)) {
      return {
        kind: "error",
        message: `入力 ${targetPath} は --root ${rootDir} の配下にありません`,
      };
    }
    return { kind: "root", rootDir, reason: "explicit" };
  }
  let dir = targetDir;
  for (;;) {
    if (deps.isFile(path.join(dir, CONFIG_FILE_NAME))) {
      return { kind: "root", rootDir: dir, reason: dir === targetDir ? "target" : "config" };
    }
    if (deps.exists(path.join(dir, ".git"))) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return { kind: "root", rootDir: targetDir, reason: "target" };
}

/** CLI の 1 行表示用 */
export function describeRootReason(reason: RootReason): string {
  switch (reason) {
    case "explicit":
      return "--root";
    case "config":
      return `上位の ${CONFIG_FILE_NAME} の場所`;
    case "target":
      return "入力と同じ場所";
  }
}
