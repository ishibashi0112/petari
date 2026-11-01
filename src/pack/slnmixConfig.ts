/**
 * リポジトリにコミットする設定ファイル(petari.config.json。旧名 slnmix.config.json も読む。任意)の読み込み。
 *
 * ルート直下に置く。**なくても動く**。
 * ハイブリッド構成(WinForms + WebView2 + React)で、.vbproj に乗らない
 * web 側・契約側のディレクトリを同じパックへ入れるための設定。
 *
 * - extraRoots: 宣言されたディレクトリだけを走査する(ディレクトリ走査を
 *   しない原則の、明示的でスコープの狭い例外)
 * - contractSchema / generatedDirs: 同じ場所に webview2-bridge.gen.json が
 *   あれば自動検出して既定値にする。明示すれば上書き
 * - kind: "generic"(旧 slnmix v0.17.0〜)で .sln / .vbproj のないプロジェクト(TypeScript 等)
 *   をパックする。extraRoots があればそのディレクトリだけ、無ければ git が管理しているファイル
 *   (設計書 §25.7)。既定は "solution"(従来どおり)
 *
 * 壊れた設定でもクラッシュせず、診断に残して設定なしとして続行する。
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { TOOL_NAME } from "../brand.ts";
import { DEFAULT_DOCS_CONFIG } from "./assets/docTemplates.ts";
import { normalizeGlobPath } from "./globMatcher.ts";
import type { ParseDiagnostic } from "./types.ts";

/** リポジトリにコミットする設定ファイル(新しい名前。ツール名に合わせる) */
export const CONFIG_FILE_NAME = `${TOOL_NAME}.config.json`;
/** 旧 slnmix の設定ファイル。名前を変えなくても読む(両方あればエラー。設計書 §25.3-2) */
export const LEGACY_CONFIG_FILE_NAME = "slnmix.config.json";
/** 探す名前(両方あるときはどちらも使わずエラー) */
export const CONFIG_FILE_NAMES: readonly string[] = [CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME];
export const GEN_CONFIG_FILE_NAME = "webview2-bridge.gen.json";

export type ConfigFileLookup =
  | { kind: "none" }
  | { kind: "found"; name: string; text: string }
  | { kind: "conflict" };

/** ディレクトリ直下の設定ファイルを読む(どちらの名前でも。両方あれば conflict) */
export function readConfigFile(directory: string, deps: SlnmixConfigDeps): ConfigFileLookup {
  const found: { name: string; text: string }[] = [];
  for (const name of CONFIG_FILE_NAMES) {
    const text = deps.readTextFile(path.join(directory, name));
    if (text !== undefined) {
      found.push({ name, text });
    }
  }
  const [first] = found;
  if (first === undefined) {
    return { kind: "none" };
  }
  return found.length > 1 ? { kind: "conflict" } : { kind: "found", ...first };
}

/** ディレクトリ直下に設定ファイルがあるか(どちらの名前でも) */
export function hasConfigFile(directory: string, isFile: (absolutePath: string) => boolean): boolean {
  return CONFIG_FILE_NAMES.some((name) => isFile(path.join(directory, name)));
}

/** 設定ファイルの名前(ディレクトリにある方。無ければ新しい名前) */
export function configFileNameIn(directory: string, isFile: (absolutePath: string) => boolean): string {
  return CONFIG_FILE_NAMES.find((name) => isFile(path.join(directory, name))) ?? CONFIG_FILE_NAME;
}

export function describeConfigConflict(directory: string): string {
  return `${directory} に ${CONFIG_FILE_NAME} と ${LEGACY_CONFIG_FILE_NAME} が両方あります。どちらを使うか決められないので、1 つにまとめてください(${LEGACY_CONFIG_FILE_NAME} はそのままの名前でも読めます)。`;
}

export interface ExtraRootConfig {
  /** ルート相対のディレクトリ(`/` 区切りに正規化済み) */
  path: string;
  /** 用途の名前(出力の root 属性・グループ表示に使う)。例: web / contract */
  kind: string;
  /** path 基準の include グロブ。省略時は kind ごとの既定 */
  include: string[];
  /** path 基準の exclude グロブ(既定の除外に追加) */
  exclude: string[];
}

/**
 * docs/ 連携(フェーズ 6)。設計書・仕様書・引継ぎ書の置き場(ルート相対)。
 * `"docs": true` で既定の配置、オブジェクトで個別指定。なければ連携なし
 */
export interface DocsConfig {
  /** 設計書のディレクトリ(直下の *.md をすべて設計書とみなす) */
  design: string;
  /** 仕様書のディレクトリ(直下の *.md をすべて仕様書とみなす) */
  spec: string;
  /** 引継ぎ書のファイル(1 ファイル固定) */
  handoff: string;
}

/**
 * プロジェクトの構成の種類。
 * - "solution": .sln / .vbproj の論理構成に基づく(既定。従来どおり)
 * - "generic": .sln / .vbproj を使わず、extraRoots に宣言されたディレクトリだけで
 *   パックする(VB.NET 以外のプロジェクト向け。v0.17.0〜)。引数なしの `petari pack`
 *   がこの設定を見て .sln の探索を省く。明示フラグにしたのは「.sln を探さなかった」
 *   理由をログで示すため(決定ログ 2026-10-10)
 */
export const CONFIG_KINDS = ["solution", "generic"] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

export function isConfigKind(value: string): value is ConfigKind {
  return (CONFIG_KINDS as readonly string[]).includes(value);
}

export interface SlnmixConfig {
  /** 構成の種類(省略時 "solution") */
  kind: ConfigKind;
  /**
   * 入力(.sln / .vbproj)のルート相対パス。引数なしの `petari pack` がこれを使う
   * (web + dotnet を分けた構成で .sln がサブディレクトリにあるとき用)
   */
  target?: string | undefined;
  extraRoots: ExtraRootConfig[];
  /** docs/ 連携の設定(なければ undefined = 連携なし) */
  docs?: DocsConfig | undefined;
  /** contract.schema.json のルート相対パス(なければ undefined) */
  contractSchema?: string | undefined;
  /** 契約の正本(contract.ts)のルート相対パス(<contract_summary> の説明用) */
  contractFile?: string | undefined;
  /** 生成コードのディレクトリ(ルート相対)。既定で除外し要約で代替する */
  generatedDirs: string[];
  /** 設定の出どころ(表示用)。例: ["petari.config.json", "webview2-bridge.gen.json"] */
  sources: string[];
}

export interface SlnmixConfigDeps {
  readTextFile(absolutePath: string): string | undefined;
}

export interface SlnmixConfigResult {
  config: SlnmixConfig;
  diagnostics: ParseDiagnostic[];
  /** 設定ファイルが新旧の名前で両方あるとき(config は設定なしと同じ)。呼び出し側は止める */
  conflict?: string | undefined;
}

/** kind ごとの include 既定 */
const DEFAULT_INCLUDE: Readonly<Record<string, readonly string[]>> = {
  web: ["**/*.{ts,tsx,js,jsx,css,json,html}"],
  /** VB.NET 以外のプロジェクトのソース(kind: "generic" の --init-config が使う) */
  src: ["**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,json,html,md}"],
  contract: ["**/*.ts"],
  /** 自動テスト(e2e/ 等)。kind: "test" があれば手順文に「自動テスト」の節が入る */
  test: ["**/*.{ts,tsx,json,md}"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return undefined;
  }
  return value;
}

/** ルート相対パスを `/` 区切り・末尾スラッシュなしに正規化 */
export function normalizeRootRelative(value: string): string {
  return normalizeGlobPath(value).replace(/\/+$/, "");
}

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^﻿/, ""));
}

export function defaultIncludeFor(kind: string): string[] {
  return [...(DEFAULT_INCLUDE[kind] ?? ["**/*"])];
}

function parseExtraRoots(
  value: unknown,
  fileName: string,
  diagnostics: ParseDiagnostic[],
): ExtraRootConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      severity: "warning",
      message: `${fileName}: extraRoots は配列で指定してください(無視します)`,
    });
    return [];
  }
  const roots: ExtraRootConfig[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: extraRoots[${index}] はオブジェクトで指定してください(無視します)`,
      });
      return;
    }
    const rawPath = asString(entry["path"]);
    if (rawPath === undefined || rawPath.trim() === "") {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: extraRoots[${index}] に path がありません(無視します)`,
      });
      return;
    }
    const rootPath = normalizeRootRelative(rawPath);
    if (rootPath === "" || rootPath.startsWith("../") || path.isAbsolute(rawPath)) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: extraRoots[${index}].path はルート配下の相対パスで指定してください: ${rawPath}(無視します)`,
      });
      return;
    }
    const kind = asString(entry["kind"])?.trim() || "extra";
    const include = asStringArray(entry["include"]);
    if (entry["include"] !== undefined && include === undefined) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: extraRoots[${index}].include は文字列の配列で指定してください(既定を使います)`,
      });
    }
    const exclude = asStringArray(entry["exclude"]);
    if (entry["exclude"] !== undefined && exclude === undefined) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: extraRoots[${index}].exclude は文字列の配列で指定してください(無視します)`,
      });
    }
    roots.push({
      path: rootPath,
      kind,
      include: include !== undefined && include.length > 0 ? include : defaultIncludeFor(kind),
      exclude: exclude ?? [],
    });
  });
  return roots;
}

/**
 * webview2-bridge.gen.json から contractSchema / generatedDirs の既定値を取る。
 * 形式: { schemaOut, ts: { outDir }, vb: { outDir } }(いずれも任意)
 */
function readGenConfig(
  rootDir: string,
  deps: SlnmixConfigDeps,
  diagnostics: ParseDiagnostic[],
): { contractSchema?: string | undefined; contractFile?: string | undefined; generatedDirs: string[] } | undefined {
  const text = deps.readTextFile(path.join(rootDir, GEN_CONFIG_FILE_NAME));
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      message: `${GEN_CONFIG_FILE_NAME} を JSON として読めません(無視します): ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const generatedDirs: string[] = [];
  for (const section of ["vb", "ts"]) {
    const sub = parsed[section];
    const outDir = isRecord(sub) ? asString(sub["outDir"]) : undefined;
    if (outDir !== undefined && outDir.trim() !== "") {
      generatedDirs.push(normalizeRootRelative(outDir));
    }
  }
  const schemaOut = asString(parsed["schemaOut"]);
  const contract = asString(parsed["contract"]);
  return {
    contractSchema:
      schemaOut !== undefined && schemaOut.trim() !== ""
        ? normalizeRootRelative(schemaOut)
        : undefined,
    contractFile:
      contract !== undefined && contract.trim() !== ""
        ? normalizeRootRelative(contract)
        : undefined,
    generatedDirs,
  };
}

/**
 * docs 設定を読む。`true` なら既定配置、オブジェクトなら各キーを既定に重ねる。
 * ルート外・絶対パスは警告して既定値に戻す(壊れた設定でも連携を落とさない)。
 */
function parseDocsConfig(
  value: unknown,
  fileName: string,
  diagnostics: ParseDiagnostic[],
): DocsConfig | undefined {
  if (value === undefined || value === false || value === null) {
    return undefined;
  }
  if (value === true) {
    return { ...DEFAULT_DOCS_CONFIG };
  }
  if (!isRecord(value)) {
    diagnostics.push({
      severity: "warning",
      message: `${fileName}: docs は true またはオブジェクトで指定してください(無視します)`,
    });
    return undefined;
  }
  const pick = (key: keyof DocsConfig): string => {
    const raw = value[key];
    if (raw === undefined) {
      return DEFAULT_DOCS_CONFIG[key];
    }
    const text = asString(raw);
    if (text === undefined || text.trim() === "") {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: docs.${key} は文字列で指定してください(既定 ${DEFAULT_DOCS_CONFIG[key]} を使います)`,
      });
      return DEFAULT_DOCS_CONFIG[key];
    }
    const normalized = normalizeRootRelative(text);
    if (normalized === "" || normalized.startsWith("../") || path.isAbsolute(text)) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName}: docs.${key} はルート配下の相対パスで指定してください: ${text}(既定 ${DEFAULT_DOCS_CONFIG[key]} を使います)`,
      });
      return DEFAULT_DOCS_CONFIG[key];
    }
    return normalized;
  };
  return { design: pick("design"), spec: pick("spec"), handoff: pick("handoff") };
}

/** `kind`: "solution" / "generic"。それ以外は警告して既定の "solution" */
function parseKind(value: unknown, fileName: string, diagnostics: ParseDiagnostic[]): ConfigKind {
  if (value === undefined) {
    return "solution";
  }
  const text = asString(value)?.trim();
  if (text !== undefined && isConfigKind(text)) {
    return text;
  }
  diagnostics.push({
    severity: "warning",
    message: `${fileName}: kind は ${CONFIG_KINDS.map((k) => `"${k}"`).join(" / ")} のいずれかを指定してください: ${String(value)}(既定の "solution" を使います)`,
  });
  return "solution";
}

const TARGET_EXTENSION = /\.(sln|vbproj)$/i;

/** `target`: ルート配下の相対パスで .sln / .vbproj を指す。それ以外は警告して無視 */
function parseTarget(value: unknown, fileName: string, diagnostics: ParseDiagnostic[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = asString(value);
  if (text === undefined || text.trim() === "") {
    diagnostics.push({
      severity: "warning",
      message: `${fileName}: target は文字列で指定してください(無視します)`,
    });
    return undefined;
  }
  const normalized = normalizeRootRelative(text);
  if (normalized === "" || normalized.startsWith("../") || path.isAbsolute(text)) {
    diagnostics.push({
      severity: "warning",
      message: `${fileName}: target はルート配下の相対パスで指定してください: ${text}(無視します)`,
    });
    return undefined;
  }
  if (!TARGET_EXTENSION.test(normalized)) {
    diagnostics.push({
      severity: "warning",
      message: `${fileName}: target は .sln / .vbproj を指定してください: ${text}(無視します)`,
    });
    return undefined;
  }
  return normalized;
}

/**
 * @param rootDir ルート(設定ファイルのあるディレクトリ。rootResolver.ts で決めたもの)の絶対パス
 */
export function loadSlnmixConfig(
  rootDir: string,
  deps: SlnmixConfigDeps,
): SlnmixConfigResult {
  const diagnostics: ParseDiagnostic[] = [];
  const config: SlnmixConfig = {
    kind: "solution",
    extraRoots: [],
    generatedDirs: [],
    sources: [],
  };

  let explicitSchema: string | undefined;
  let explicitContractFile: string | undefined;
  let explicitGenerated: string[] | undefined;

  const found = readConfigFile(rootDir, deps);
  if (found.kind === "conflict") {
    return { config, diagnostics, conflict: describeConfigConflict(rootDir) };
  }
  const text = found.kind === "found" ? found.text : undefined;
  const fileName = found.kind === "found" ? found.name : CONFIG_FILE_NAME;
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseJson(text);
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName} を JSON として読めません(設定なしとして続行): ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      parsed = undefined;
    }
    if (parsed !== undefined && !isRecord(parsed)) {
      diagnostics.push({
        severity: "warning",
        message: `${fileName} のトップレベルはオブジェクトで指定してください(設定なしとして続行)`,
      });
      parsed = undefined;
    }
    if (isRecord(parsed)) {
      config.sources.push(fileName);
      config.kind = parseKind(parsed["kind"], fileName, diagnostics);
      const target = parseTarget(parsed["target"], fileName, diagnostics);
      if (target !== undefined) {
        if (config.kind === "generic") {
          diagnostics.push({
            severity: "warning",
            message: `${fileName}: kind が "generic" のため target は使いません(無視します): ${target}`,
          });
        } else {
          config.target = target;
        }
      }
      config.extraRoots = parseExtraRoots(parsed["extraRoots"], fileName, diagnostics);
      // generic で extraRoots が無ければ、git が管理しているファイルを対象にする(設計書 §25.7)
      config.docs = parseDocsConfig(parsed["docs"], fileName, diagnostics);
      const schema = asString(parsed["contractSchema"]);
      if (schema !== undefined && schema.trim() !== "") {
        explicitSchema = normalizeRootRelative(schema);
      }
      const contractFile = asString(parsed["contractFile"]);
      if (contractFile !== undefined && contractFile.trim() !== "") {
        explicitContractFile = normalizeRootRelative(contractFile);
      }
      const generated = asStringArray(parsed["generatedDirs"]);
      if (parsed["generatedDirs"] !== undefined && generated === undefined) {
        diagnostics.push({
          severity: "warning",
          message: `${fileName}: generatedDirs は文字列の配列で指定してください(無視します)`,
        });
      }
      if (generated !== undefined) {
        explicitGenerated = generated
          .map(normalizeRootRelative)
          .filter((dir) => dir !== "");
      }
    }
  }

  const gen = readGenConfig(rootDir, deps, diagnostics);
  if (gen !== undefined) {
    config.sources.push(GEN_CONFIG_FILE_NAME);
  }
  config.contractSchema = explicitSchema ?? gen?.contractSchema;
  config.contractFile = explicitContractFile ?? gen?.contractFile;
  config.generatedDirs = explicitGenerated ?? gen?.generatedDirs ?? [];

  return { config, diagnostics };
}
