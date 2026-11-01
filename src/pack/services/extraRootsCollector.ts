/**
 * slnmix.config.json の extraRoots(.vbproj に乗らない web / 契約ディレクトリ)
 * からファイルを集める。
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
