/**
 * 設定ファイルの extraRoots(.vbproj に乗らない web / 契約ディレクトリ)
 * からファイルを集める。generic 構成で extraRoots が無いときは、git が管理している
 * ファイルの一覧(collectGitFiles)から集める(設計書 §25.7)。
 *
 * 「ディレクトリ走査をしない」原則の、明示的でスコープの狭い例外。
 * 宣言されたディレクトリだけを走査し、include / exclude グロブ(globMatcher)
 * と既定の除外(node_modules / dist / build / .vite / *.map / .env* /
 * バイナリ拡張子 / .gitignore)を適用する。
 *
 * 除外したものは理由付きで skipped に残す(黙って捨てない)。ただし
 * node_modules 等の「既定で必ず除外」は件数だけ診断に残す(数千件になるため)。
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { globToRegExp, normalizeGlobPath } from "../globMatcher.ts";
import type { ExtraRootConfig } from "../slnmixConfig.ts";
import type { ParseDiagnostic } from "../types.ts";
import { isBinaryExtension } from "./binaryExtensions.ts";

export interface ExtraRootFile {
  /** 用途(root 属性)。例: web */
  kind: string;
  /** 追加ルートのディレクトリ(ルート相対・`/` 区切り) */
  rootPath: string;
  /** ファイルのルート相対パス(`/` 区切り)。出力の path 属性にそのまま使う */
  relativePath: string;
  absolutePath: string;
}

export interface ExtraRootSkipped {
  relativePath: string;
  reason: string;
}

export interface ExtraRootsDeps {
  /** ディレクトリ配下の全ファイルの絶対パス(再帰)。走査できなければ undefined */
  listFilesRecursive(absoluteDir: string): string[] | undefined;
  /** .gitignore / .repomixignore による除外判定(根拠のファイルを返す)。未指定なら判定しない */
  ignoreReasonFor?: ((absolutePath: string) => string | undefined) | undefined;
}

export interface ExtraRootsResult {
  files: ExtraRootFile[];
  skipped: ExtraRootSkipped[];
  diagnostics: ParseDiagnostic[];
}

/** include に関わらず常に除外するパターン(追加ルートのディレクトリ基準) */
export const ALWAYS_EXCLUDE_GLOBS: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.vite/**",
  "**/*.map",
  "**/.env",
  "**/.env.*",
];

const ALWAYS_EXCLUDE_REGEXPS = ALWAYS_EXCLUDE_GLOBS.map(globToRegExp);

/**
 * @param rootDir ルートの絶対パス(extraRoots[].path の基準)
 */
export function collectExtraRoots(
  rootDir: string,
  roots: readonly ExtraRootConfig[],
  deps: ExtraRootsDeps,
): ExtraRootsResult {
  const files: ExtraRootFile[] = [];
  const skipped: ExtraRootSkipped[] = [];
  const diagnostics: ParseDiagnostic[] = [];

  for (const root of roots) {
    const absoluteRoot = path.resolve(rootDir, ...root.path.split("/"));
    const listed = deps.listFilesRecursive(absoluteRoot);
    if (listed === undefined) {
      diagnostics.push({
        severity: "warning",
        message: `extraRoots のディレクトリを走査できません(スキップ): ${root.path}`,
      });
      continue;
    }
    const includeRegExps = root.include.map(globToRegExp);
    const excludeRegExps = root.exclude.map(globToRegExp);
    let alwaysExcludedCount = 0;
    let notIncludedCount = 0;
    const collected: ExtraRootFile[] = [];

    for (const absolutePath of listed) {
      const relativeToRoot = normalizeGlobPath(path.relative(absoluteRoot, absolutePath));
      if (relativeToRoot === "" || relativeToRoot.startsWith("../")) {
        continue;
      }
      const relativePath = `${root.path}/${relativeToRoot}`;
      if (ALWAYS_EXCLUDE_REGEXPS.some((re) => re.test(relativeToRoot))) {
        alwaysExcludedCount += 1;
        continue;
      }
      if (!includeRegExps.some((re) => re.test(relativeToRoot))) {
        notIncludedCount += 1;
        continue;
      }
      if (excludeRegExps.some((re) => re.test(relativeToRoot))) {
        skipped.push({ relativePath, reason: "extraRoots の exclude に一致" });
        continue;
      }
      if (isBinaryExtension(path.basename(absolutePath))) {
        skipped.push({ relativePath, reason: "バイナリ拡張子" });
        continue;
      }
      const ignoreSource = deps.ignoreReasonFor?.(absolutePath);
      if (ignoreSource !== undefined) {
        skipped.push({ relativePath, reason: `.gitignore により除外(${ignoreSource})` });
        continue;
      }
      collected.push({ kind: root.kind, rootPath: root.path, relativePath, absolutePath });
    }

    collected.sort((a, b) =>
      a.relativePath.toLowerCase().localeCompare(b.relativePath.toLowerCase()),
    );
    files.push(...collected);
    diagnostics.push({
      severity: "info",
      message: `extraRoots [${root.kind}] ${root.path}: ${collected.length} 件(既定の除外 ${alwaysExcludedCount} 件、include 対象外 ${notIncludedCount} 件)`,
    });
  }

  return { files, skipped, diagnostics };
}

/** git の一覧から集めるときの 1 ファイルの上限(バイト)。超えるものは除外して理由を残す */
export const GIT_FILE_MAX_BYTES = 256 * 1024;

/** 依存の版を固定するだけのロックファイル(コードの理解に要らず、大きい) */
const LOCK_FILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "cargo.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
]);

export function isLockFile(fileName: string): boolean {
  return LOCK_FILE_NAMES.has(fileName.toLowerCase());
}

/** git の一覧から集めたファイルの kind(<directory_structure> の見出しに使う) */
export const GIT_FILES_KIND = "git";

export interface GitFilesDeps {
  /** ファイルのサイズ(バイト)。通常のファイルでない・無いときは undefined */
  fileSize(absolutePath: string): number | undefined;
  /** .gitignore / .repomixignore による除外判定(根拠のファイルを返す)。未指定なら判定しない */
  ignoreReasonFor?: ((absolutePath: string) => string | undefined) | undefined;
  /** パックの別の場所(<docs> / <db_schema>)に入るファイルなら、その説明(重ねて入れない) */
  shownElsewhere?: ((relativePath: string) => string | undefined) | undefined;
}

/**
 * git が管理しているファイル(`git ls-files --cached --others --exclude-standard` の結果)から、
 * パックに入れるものを選ぶ。一覧はリポジトリが宣言したものなので、ディレクトリを走査しない
 * 原則の趣旨(推測で対象を決めない)に合う(設計書 §25.7)。除外するもの: 既定の除外
 * (node_modules / dist / build / .env など。extraRoots と同じ)・バイナリ拡張子・ロックファイル・
 * GIT_FILE_MAX_BYTES を超えるもの・.gitignore / .repomixignore に一致するもの(追跡中でも)・
 * 通常のファイルでないもの(削除済み・サブモジュール)。
 *
 * @param rootDir ルートの絶対パス(relativePaths の基準)
 * @param relativePaths ルート相対のパス(`/` 区切り)
 */
export function collectGitFiles(
  rootDir: string,
  relativePaths: readonly string[],
  deps: GitFilesDeps,
): ExtraRootsResult {
  const files: ExtraRootFile[] = [];
  const skipped: ExtraRootSkipped[] = [];
  let alwaysExcludedCount = 0;
  for (const raw of relativePaths) {
    const relativePath = normalizeGlobPath(raw);
    if (relativePath === "" || relativePath.startsWith("../") || relativePath.startsWith("/")) {
      continue;
    }
    if (ALWAYS_EXCLUDE_REGEXPS.some((re) => re.test(relativePath))) {
      alwaysExcludedCount += 1;
      continue;
    }
    const absolutePath = path.resolve(rootDir, ...relativePath.split("/"));
    const name = path.basename(absolutePath);
    if (isBinaryExtension(name)) {
      skipped.push({ relativePath, reason: "バイナリ拡張子" });
      continue;
    }
    if (isLockFile(name)) {
      skipped.push({ relativePath, reason: "ロックファイル(依存の版の固定)" });
      continue;
    }
    const elsewhere = deps.shownElsewhere?.(relativePath);
    if (elsewhere !== undefined) {
      skipped.push({ relativePath, reason: `${elsewhere} に入れたため <file> には入れない` });
      continue;
    }
    const ignoreSource = deps.ignoreReasonFor?.(absolutePath);
    if (ignoreSource !== undefined) {
      skipped.push({ relativePath, reason: `.gitignore により除外(${ignoreSource})` });
      continue;
    }
    const size = deps.fileSize(absolutePath);
    if (size === undefined) {
      skipped.push({ relativePath, reason: "通常のファイルではない(削除済み・サブモジュールなど)" });
      continue;
    }
    if (size > GIT_FILE_MAX_BYTES) {
      skipped.push({
        relativePath,
        reason: `大きいファイル(${Math.ceil(size / 1024)}KB。上限 ${GIT_FILE_MAX_BYTES / 1024}KB)`,
      });
      continue;
    }
    files.push({ kind: GIT_FILES_KIND, rootPath: "", relativePath, absolutePath });
  }
  files.sort((a, b) => a.relativePath.toLowerCase().localeCompare(b.relativePath.toLowerCase()));
  return {
    files,
    skipped,
    diagnostics: [
      {
        severity: "info",
        message: `git が管理しているファイル: ${files.length} 件(既定の除外 ${alwaysExcludedCount} 件、その他の除外 ${skipped.length} 件)`,
      },
    ],
  };
}
