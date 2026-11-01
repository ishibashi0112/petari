/**
 * pack / build / init が共有するファイル I/O と、入力(.sln / .vbproj / generic 構成)とルートの決め方。
 * src/pack/ の解析コアは deps 注入で I/O を持たないため、実際のファイルシステムをここでつなぐ。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeSourceBuffer } from "../pack/services/repomixExporter.ts";
import { GitignoreEvaluator } from "../pack/services/gitignoreService.ts";
import { CONFIG_FILE_NAME, loadSlnmixConfig } from "../pack/slnmixConfig.ts";
import { describeRootReason, resolveRoot } from "../pack/rootResolver.ts";
import { resolveTarget } from "../pack/targetResolver.ts";
import type { ParseDiagnostic } from "../pack/types.ts";
import { err } from "../infra/term.ts";

export interface FsDeps {
  fileExists(absolutePath: string): boolean;
  listFileNames(absolutePath: string): string[] | undefined;
  listFilesRecursive(absoluteDir: string): string[] | undefined;
}

export const FS_DEPS: FsDeps = {
  fileExists: (absolutePath) => fs.existsSync(absolutePath),
  listFileNames: (absolutePath) => {
    try {
      return fs
        .readdirSync(absolutePath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return undefined;
    }
  },
  // SDK スタイルの既定グロブ展開用。シンボリックリンクは辿らない(循環防止)。
  // bin / obj 等の除外はパーサー側で行う(ここは列挙のみ)
  listFilesRecursive: (absoluteDir) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const results: string[] = [];
    const walk = (dir: string, dirEntries: fs.Dirent[]): void => {
      for (const entry of dirEntries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          try {
            walk(full, fs.readdirSync(full, { withFileTypes: true }));
          } catch {
            // 読めないディレクトリは飛ばす(取れた分だけ出す)
          }
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    };
    walk(absoluteDir, entries);
    return results;
  },
};

export function listDirectoryNames(absolutePath: string): string[] | undefined {
  try {
    return fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
}

export function isDirectoryPath(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

export function isFilePath(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** ソース/プロジェクトファイルを文字コード自動判定(BOM / UTF-8 / CP932)で読む */
export function readSourceTextFile(absolutePath: string): string | undefined {
  try {
    return decodeSourceBuffer(fs.readFileSync(absolutePath));
  } catch {
    return undefined;
  }
}

/** .gitignore / .repomixignore の判定(パックとビルドで同じものを使う) */
export function createGitignoreEvaluator(rootDir: string): GitignoreEvaluator {
  return new GitignoreEvaluator(
    {
      readTextFileIfExists: (absolutePath) => {
        try {
          return fs.readFileSync(absolutePath, "utf8");
        } catch {
          return undefined;
        }
      },
      directoryExists: (absolutePath) => {
        try {
          return fs.statSync(absolutePath).isDirectory();
        } catch {
          return false;
        }
      },
    },
    rootDir,
  );
}

export function printDiagnostics(label: string, diagnostics: ParseDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "info") {
      continue; // CLI では警告以上のみ表示(出力本文の skipped_files に詳細が載る)
    }
    err(`[${diagnostic.severity}] ${label}: ${diagnostic.message}`);
  }
}

export type TargetAndRoot =
  /** usageHint: 入力の指定の誤り(使い方の案内を添える) */
  | { kind: "error"; message: string; usageHint: boolean }
  /** targetPath が undefined なら generic 構成(.sln / .vbproj を使わない) */
  | { kind: "ok"; targetPath: string | undefined; rootDir: string };

/**
 * 入力(.sln / .vbproj / ディレクトリ / 省略)とルートを決める(パックとビルドで同じ)。
 * solution: --root > 上位の設定ファイルの場所 > 入力と同じ場所(rootResolver.ts)
 * generic: 設定ファイルの場所に固定(--root は使えない。基準が設定と食い違うため)
 */
export function resolveTargetAndRoot(
  inputArg: string | undefined,
  rootArg: string | undefined,
  options: { legacyPaths: boolean },
): TargetAndRoot {
  const resolution = resolveTarget(inputArg, process.cwd(), {
    isDirectory: isDirectoryPath,
    isFile: isFilePath,
    listFileNames: FS_DEPS.listFileNames,
    // 引数なし(またはディレクトリ指定)のとき、その場所の設定ファイルの target を使う
    readConfigTarget: (directory) =>
      loadSlnmixConfig(directory, { readTextFile: readSourceTextFile }).config.target,
    // 同じ場所の設定が kind: "generic" なら .sln / .vbproj を探さない
    isGenericConfig: (directory) =>
      loadSlnmixConfig(directory, { readTextFile: readSourceTextFile }).config.kind === "generic",
  });
  if (resolution.kind === "error") {
    return { kind: "error", message: resolution.message, usageHint: true };
  }
  if (resolution.kind === "generic") {
    if (rootArg !== undefined && path.resolve(process.cwd(), rootArg) !== resolution.rootDir) {
      return {
        kind: "error",
        message: `kind: "generic" の構成では --root は使えません(ルートは ${CONFIG_FILE_NAME} の場所: ${resolution.rootDir})。`,
        usageHint: false,
      };
    }
    if (options.legacyPaths) {
      return {
        kind: "error",
        message: 'kind: "generic" の構成では --legacy-paths は使えません(論理パスがありません)。',
        usageHint: false,
      };
    }
    err(`対象: generic 構成(${CONFIG_FILE_NAME} の kind。.sln / .vbproj は使いません)`);
    err(`ルート: ${resolution.rootDir}`);
    return { kind: "ok", targetPath: undefined, rootDir: resolution.rootDir };
  }
  const targetPath = resolution.path;
  if (resolution.autoDetected) {
    err(`対象: ${targetPath}(${resolution.source === "config" ? `${CONFIG_FILE_NAME} の target` : "自動検出"})`);
  }
  const root = resolveRoot(targetPath, rootArg, process.cwd(), {
    isDirectory: isDirectoryPath,
    isFile: isFilePath,
    exists: (p) => fs.existsSync(p),
  });
  if (root.kind === "error") {
    return { kind: "error", message: root.message, usageHint: false };
  }
  if (root.reason !== "target") {
    err(`ルート: ${root.rootDir}(${describeRootReason(root.reason)})`);
  }
  return { kind: "ok", targetPath, rootDir: root.rootDir };
}
