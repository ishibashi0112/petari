/**
 * slnmix --init-config: VB.NET 以外のプロジェクト(TypeScript 等)で slnmix を使う
 * ための slnmix.config.json(kind: "generic")を作る(v0.17.0、設計書 §19)。
 *
 * - 既に slnmix.config.json があれば何もしない(冪等。中身は変えない)
 * - その場所に .sln / .vbproj があれば作らない(従来の solution 構成で動くため)
 * - ソースのディレクトリは「候補名のうち実在するもの」だけを採用する(src / app /
 *   lib / apps / packages → kind: "src"、tests / test / e2e / __tests__ →
 *   kind: "test")。1 つも無ければ推測で書かずエラーにし、例を示す
 *
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { CONFIG_FILE_NAME } from "./slnmixConfig.ts";

export interface InitConfigDeps {
  isDirectory(absolutePath: string): boolean;
  isFile(absolutePath: string): boolean;
  /** ディレクトリ直下のファイル名一覧(取得できなければ undefined) */
  listFileNames(absolutePath: string): string[] | undefined;
  writeTextFile(absolutePath: string, content: string): void;
}

export type InitConfigResult =
  | { kind: "created"; path: string; content: string; roots: InitConfigRoot[] }
  | { kind: "kept"; path: string }
  | { kind: "error"; message: string };

export interface InitConfigRoot {
  path: string;
  kind: "src" | "test";
}

/** ソースの候補ディレクトリ(この順で並ぶ) */
export const SOURCE_DIR_CANDIDATES: readonly string[] = ["src", "app", "lib", "apps", "packages"];
/** 自動テストの候補ディレクトリ */
export const TEST_DIR_CANDIDATES: readonly string[] = ["tests", "test", "e2e", "__tests__"];

/** 候補が 1 つも無いときに案内する設定例 */
export const EXAMPLE_CONFIG = `{
  "kind": "generic",
  "extraRoots": [
    { "path": "src", "kind": "src" },
    { "path": "tests", "kind": "test" }
  ]
}`;

function renderConfig(roots: readonly InitConfigRoot[]): string {
  const lines = roots.map(
    (root, index) =>
      `    { "path": "${root.path}", "kind": "${root.kind}" }${index === roots.length - 1 ? "" : ","}`,
  );
  return ["{", '  "kind": "generic",', '  "extraRoots": [', ...lines, "  ]", "}", ""].join("\n");
}

/**
 * @param rootDir 設定を置くディレクトリ(プロジェクトルート)の絶対パス
 */
export function initConfig(rootDir: string, deps: InitConfigDeps): InitConfigResult {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (deps.isFile(configPath)) {
    return { kind: "kept", path: configPath };
  }
  const names = deps.listFileNames(rootDir) ?? [];
  const solutionFiles = names.filter((name) => /\.(sln|vbproj)$/i.test(name)).sort();
  if (solutionFiles.length > 0) {
    return {
      kind: "error",
      message: [
        `${rootDir} には ${solutionFiles.join(", ")} があります。VB.NET のプロジェクトは設定なしで npx slnmix を実行できます(kind: "generic" は .sln / .vbproj の無いプロジェクト向け)。`,
      ].join("\n"),
    };
  }
  const roots: InitConfigRoot[] = [];
  for (const name of SOURCE_DIR_CANDIDATES) {
    if (deps.isDirectory(path.join(rootDir, name))) {
      roots.push({ path: name, kind: "src" });
    }
  }
  for (const name of TEST_DIR_CANDIDATES) {
    if (deps.isDirectory(path.join(rootDir, name))) {
      roots.push({ path: name, kind: "test" });
    }
  }
  if (!roots.some((root) => root.kind === "src")) {
    return {
      kind: "error",
      message: [
        `${rootDir} にソースのディレクトリ(${SOURCE_DIR_CANDIDATES.join(" / ")})が見つかりません。推測では作らないので、${CONFIG_FILE_NAME} を手で作ってください。例:`,
        EXAMPLE_CONFIG,
      ].join("\n"),
    };
  }
  const content = renderConfig(roots);
  deps.writeTextFile(configPath, content);
  return { kind: "created", path: configPath, content, roots };
}
