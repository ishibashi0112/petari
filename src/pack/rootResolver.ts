/**
 * ルート(物理パス・設定ファイル・protocol.md / procedure.md・docs/・出力先の基準)を決める。
 * パック(tazuna pack / build)と適用(tazuna / undo / show / list / watch / init)で同じ決め方をし、
 * パックの `<file path>` と changes.md のパスの基準を必ず一致させる(設計書 §25.3-2)。
 *
 *   1. `--root <dir>` の明示指定(パックでは入力がその配下にあること)
 *   2. 起点(パック: 入力のディレクトリ、適用: カレント)から上に向かって設定ファイル
 *      (tazuna.config.json / slnmix.config.json)を探し、最初に見つかったディレクトリ。
 *      `.git` のあるディレクトリ(リポジトリの境界)より上には行かない
 *   3. 上に向かって最初の `.git` のあるディレクトリ
 *   4. どちらもなければ起点
 *
 * 旧 slnmix は 3 を持たず(入力のディレクトリ)、旧 petari は 2 を持たなかった。設定ファイルを
 * サブフォルダに置いた構成や、.sln がサブフォルダにあり設定の無い構成で、両者のルートがずれていた。
 *
 * 純粋関数(ファイルシステムは deps 注入)。
 */

import * as path from "node:path";
import { hasConfigFile } from "./slnmixConfig.ts";

export interface RootResolverDeps {
  isDirectory(absolutePath: string): boolean;
  isFile(absolutePath: string): boolean;
  /** `.git`(ディレクトリまたはファイル)があるか。無ければ境界扱いしない */
  exists(absolutePath: string): boolean;
}

export type RootReason = "explicit" | FoundRootReason;
/** config: 設定ファイルの場所 / git: .git の場所 / start: 起点(どちらも無い) */
export type FoundRootReason = "config" | "git" | "start";

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

/** 起点から上に向かってルートを探す(--root の無いとき。2〜4) */
export function findRoot(
  startDir: string,
  deps: Pick<RootResolverDeps, "isFile" | "exists">,
): { rootDir: string; reason: FoundRootReason } {
  let dir = startDir;
  for (;;) {
    if (hasConfigFile(dir, deps.isFile)) {
      return { rootDir: dir, reason: "config" };
    }
    if (deps.exists(path.join(dir, ".git"))) {
      return { rootDir: dir, reason: "git" };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { rootDir: startDir, reason: "start" };
    }
    dir = parent;
  }
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
  return { kind: "root", ...findRoot(targetDir, deps) };
}

/** CLI の 1 行表示用 */
export function describeRootReason(reason: RootReason): string {
  switch (reason) {
    case "explicit":
      return "--root";
    case "config":
      return "設定ファイルの場所";
    case "git":
      return "リポジトリの直下(.git の場所)";
    case "start":
      return "入力と同じ場所";
  }
}
