/**
 * slnmix --init-docs: docs/ 連携の一回きりのセットアップ(フェーズ 6)。
 *
 * - docs/design/ と docs/spec/ を作る(空)
 * - docs/README.md(文書の役割と日常の流れ)を書く
 * - slnmix.config.json に "docs" 設定を追記する(既存キーは保持。docs が既に
 *   あれば変えない。壊れた JSON は上書きせずエラー)
 *
 * 引継ぎ書・設計書・仕様書のファイル自体は作らない(AI が changes.md の create で
 * 出し、petari が親ディレクトリごと作る。空の引継ぎ書を置くと「続きから」と
 * 誤判定するため)。設計書 §17 の「slnmix init は作らない」は必須セットアップを
 * petari init 一回に保つための決定で、任意機能の本コマンドはそれと矛盾しない。
 *
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { DEFAULT_DOCS_CONFIG, DOCS_README } from "./assets/docTemplates.ts";
import { CONFIG_FILE_NAME } from "./slnmixConfig.ts";

export interface InitDocsDeps {
  exists(absolutePath: string): boolean;
  readTextFile(absolutePath: string): string | undefined;
  writeTextFile(absolutePath: string, content: string): void;
  makeDirectory(absolutePath: string): void;
}

export interface InitDocsResult {
  /** 作成したもの(ルート相対) */
  created: string[];
  /** 既にあって変えなかったもの(ルート相対) */
  kept: string[];
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param rootDir ルート(.sln / .vbproj のあるディレクトリ)の絶対パス
 */
export function initDocs(rootDir: string, deps: InitDocsDeps): InitDocsResult {
  const result: InitDocsResult = { created: [], kept: [], errors: [] };
  const abs = (relative: string): string => path.resolve(rootDir, ...relative.split("/"));

  // 1. slnmix.config.json(先に。ここで失敗したらディレクトリを作らない)
  const configPath = abs(CONFIG_FILE_NAME);
  const existing = deps.readTextFile(configPath);
  let parsed: Record<string, unknown> = {};
  if (existing !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(existing.replace(/^﻿/, ""));
    } catch (error) {
      result.errors.push(
        `${CONFIG_FILE_NAME} を JSON として読めません(上書きしません): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return result;
    }
    if (!isRecord(value)) {
      result.errors.push(`${CONFIG_FILE_NAME} のトップレベルはオブジェクトである必要があります(上書きしません)`);
      return result;
    }
    parsed = value;
  }
  if (parsed["docs"] !== undefined && parsed["docs"] !== false && parsed["docs"] !== null) {
    result.kept.push(`${CONFIG_FILE_NAME} (docs 設定済み)`);
  } else {
    const next = { ...parsed, docs: { ...DEFAULT_DOCS_CONFIG } };
    deps.writeTextFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
    result.created.push(
      existing === undefined ? CONFIG_FILE_NAME : `${CONFIG_FILE_NAME} (docs 設定を追記)`,
    );
  }

  // 2. ディレクトリ(既存の設定があればその配置に従う)
  const docsConfig = isRecord(parsed["docs"])
    ? {
        design: typeof parsed["docs"]["design"] === "string" ? parsed["docs"]["design"] : DEFAULT_DOCS_CONFIG.design,
        spec: typeof parsed["docs"]["spec"] === "string" ? parsed["docs"]["spec"] : DEFAULT_DOCS_CONFIG.spec,
      }
    : { design: DEFAULT_DOCS_CONFIG.design, spec: DEFAULT_DOCS_CONFIG.spec };
  for (const dir of [docsConfig.design, docsConfig.spec]) {
    const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (deps.exists(abs(normalized))) {
      result.kept.push(`${normalized}/`);
    } else {
      deps.makeDirectory(abs(normalized));
      result.created.push(`${normalized}/`);
    }
  }

  // 3. docs/README.md(設計書ディレクトリの親に置く)
  const docsRoot = path.posix.dirname(docsConfig.design.replace(/\\/g, "/"));
  const readmeRelative = docsRoot === "." ? "README.md" : `${docsRoot}/README.md`;
  if (deps.exists(abs(readmeRelative))) {
    result.kept.push(readmeRelative);
  } else {
    // 親ディレクトリは設計書ディレクトリの作成(再帰)で存在している
    deps.writeTextFile(abs(readmeRelative), DOCS_README);
    result.created.push(readmeRelative);
  }

  return result;
}
