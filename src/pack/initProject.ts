/**
 * tazuna init: 初回セットアップを 1 コマンドにまとめる(旧 slnmix init + petari init。設計書 §20・§25)。
 *
 * 1. 構成: 設定ファイル(tazuna.config.json。旧名 slnmix.config.json も)があればそのまま使う。なければ
 *    - 直下に .sln / .vbproj があれば設定を作らない(従来どおり自動検出)
 *    - 直下に無く、1 段下のフォルダに .sln が 1 つだけあれば target で指す設定を作る
 *    - どちらも無ければ --init-config と同じ generic 構成を作る
 * 2. docs/ 連携(--init-docs と同じ)
 * 3. .gitignore に生成物(repomix-output.xml / repomix-output.prompt.md)と .tazuna/ を追記
 * 4. .tazuna/config.json(PC ごとの設定。雛形。旧版の .petari/ だけがあれば .petari/ のものを使う)
 * 5. 規約文: 内蔵なので書き出さない。旧 init が書いた protocol.md があれば、手を加えていないか
 *    (削除してよいか)を案内する
 *
 * 対話なし。既存のファイルは変えない。何度実行しても同じ結果になる(冪等)。
 * ルートはパック・適用と同じ決め方(rootResolver.ts)で呼び出し側が決める。--root でリポジトリの
 * 途中を指したときは、設定ファイルがある場所に限る(無いとパックと適用のルートがずれるため)。
 *
 * 1 段下の .sln を探すのは init だけの例外(パックの対象は決めず、見つけた .sln を
 * 設定に書いて利用者に見える形にする)。
 *
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { GitignoreRules } from "./services/gitignoreMatcher.ts";
import { initConfig, type InitConfigDeps } from "./initConfig.ts";
import { initDocs, type InitDocsDeps } from "./initDocs.ts";
import { BUILD_COMMAND, PACK_COMMAND, TOOL_NAME, stateDirectoryName } from "../brand.ts";
import { CONFIG_TEMPLATE } from "../infra/config.ts";
import { describeInstruction, resolveInstructionFile } from "./instructionFile.ts";
import {
  CONFIG_FILE_NAME,
  configFileNameIn,
  describeConfigConflict,
  hasConfigFile,
  loadSlnmixConfig,
  readConfigFile,
} from "./slnmixConfig.ts";
import { resolveTarget } from "./targetResolver.ts";

export interface InitProjectDeps extends InitDocsDeps, InitConfigDeps {
  /** ディレクトリ直下のサブディレクトリ名一覧(取得できなければ undefined) */
  listDirectoryNames(absolutePath: string): string[] | undefined;
  /** 既存ファイルの末尾に追記する(.gitignore の既存部分のバイト列を変えないため) */
  appendTextFile(absolutePath: string, content: string): void;
  log(line: string): void;
}

export interface InitProjectResult {
  exitCode: number;
  /** 決まった構成(手順 1 で止まったときは undefined) */
  layout?: "solution" | "generic" | undefined;
}

/** パックが書く生成物(既定の出力名)。git の管理外にする */
export const GENERATED_OUTPUTS: readonly string[] = [
  "repomix-output.xml",
  "repomix-output.prompt.md",
];

/** 1 段下の .sln を探すときに見ないフォルダ(ドットで始まるものも見ない) */
const SKIPPED_SUBDIRECTORIES = new Set(["node_modules", "bin", "obj", "packages"]);

const TARGET_EXTENSION = /\.(sln|vbproj)$/i;

/** .git のある最も近い祖先(自身を含む)。無ければ undefined */
export function findRepositoryRoot(
  directory: string,
  exists: (absolutePath: string) => boolean,
): string | undefined {
  let dir = directory;
  for (;;) {
    if (exists(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * .gitignore に足す行を決める。既存の規則で既に無視されるもの(`*.xml` 等)は足さない。
 * @returns 追記する文字列(足すものが無ければ undefined)と、足した項目
 */
export function planGitignoreAppend(
  current: string | undefined,
  entries: readonly string[],
): { append: string; added: string[] } | undefined {
  const matcher = new GitignoreRules(current ?? "");
  // 末尾 / の項目(ディレクトリ)は、その中のファイルが除外されるかで判定する
  const added = entries.filter((entry) => !matcher.ignores(entry.endsWith("/") ? `${entry}_` : entry));
  if (added.length === 0) {
    return undefined;
  }
  const eol = current?.includes("\r\n") ? "\r\n" : "\n";
  const lead = current === undefined || current === "" || current.endsWith("\n") ? "" : eol;
  return { append: lead + added.map((line) => line + eol).join(""), added };
}

function findSolutionsOneLevelDown(rootDir: string, deps: InitProjectDeps): string[] {
  const found: string[] = [];
  const subdirectories = (deps.listDirectoryNames(rootDir) ?? [])
    .filter((name) => !name.startsWith(".") && !SKIPPED_SUBDIRECTORIES.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  for (const name of subdirectories) {
    const files = deps.listFileNames(path.join(rootDir, name)) ?? [];
    for (const file of files.filter((f) => /\.sln$/i.test(f)).sort((a, b) => a.localeCompare(b))) {
      found.push(`${name}/${file}`);
    }
  }
  return found;
}

type LayoutStep =
  | { kind: "ok"; layout: "solution" | "generic"; lines: string[] }
  | { kind: "error"; message: string };

function setUpLayout(rootDir: string, deps: InitProjectDeps): LayoutStep {
  const found = readConfigFile(rootDir, deps);
  if (found.kind === "conflict") {
    return { kind: "error", message: describeConfigConflict(rootDir) };
  }
  const configName = found.kind === "found" ? found.name : CONFIG_FILE_NAME;
  const configPath = path.join(rootDir, configName);
  const configText = found.kind === "found" ? found.text : undefined;
  if (configText !== undefined) {
    try {
      JSON.parse(configText.replace(/^﻿/, ""));
    } catch (error) {
      return {
        kind: "error",
        message: `${configName} を JSON として読めません(上書きしません): ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const config = loadSlnmixConfig(rootDir, { readTextFile: deps.readTextFile }).config;
    const resolution = resolveTarget(undefined, rootDir, {
      ...deps,
      readConfigTarget: () => config.target,
      isGenericConfig: () => config.kind === "generic",
    });
    if (resolution.kind === "generic") {
      return {
        kind: "ok",
        layout: "generic",
        lines: [`1. 構成: generic(既存の ${configName}。変更なし)`],
      };
    }
    if (resolution.kind === "file") {
      return {
        kind: "ok",
        layout: "solution",
        lines: [
          `1. 構成: ${toRelative(rootDir, resolution.path)}(既存の ${configName}。変更なし)`,
        ],
      };
    }
    const hasDirectTarget = (deps.listFileNames(rootDir) ?? []).some((name) => TARGET_EXTENSION.test(name));
    if (config.target === undefined && !hasDirectTarget) {
      return {
        kind: "error",
        message: [
          `${configName} はありますが、対象が決まりません(直下に .sln / .vbproj が無く、target も kind: "generic" もありません)。`,
          `.sln がサブフォルダにあれば "target": "<フォルダ>/<名前>.sln" を、VB.NET 以外なら "kind": "generic" と extraRoots を書いてから、もう一度実行してください。`,
        ].join("\n"),
      };
    }
    return { kind: "error", message: resolution.message };
  }

  const names = deps.listFileNames(rootDir) ?? [];
  if (names.some((name) => TARGET_EXTENSION.test(name))) {
    const resolution = resolveTarget(undefined, rootDir, deps);
    if (resolution.kind === "file") {
      return {
        kind: "ok",
        layout: "solution",
        lines: [`1. 構成: ${path.basename(resolution.path)}(直下を自動検出。設定は不要)`],
      };
    }
    return {
      kind: "error",
      message:
        resolution.kind === "error"
          ? `${resolution.message}\n${configName} に "target": "<対象>.sln" を書いてから、もう一度実行してください。`
          : "対象を決められません。",
    };
  }

  // .sln がサブフォルダにある構成(例: dotnet/App.sln)。target で指せばルートは
  // ここ(= tazuna のルート)のまま
  const solutions = findSolutionsOneLevelDown(rootDir, deps);
  if (solutions.length === 1) {
    const target = solutions[0];
    deps.writeTextFile(configPath, `${JSON.stringify({ target }, null, 2)}\n`);
    return {
      kind: "ok",
      layout: "solution",
      lines: [`1. 構成: ${target}(1 段下で見つけた .sln を ${configName} の target に書きました)`],
    };
  }
  if (solutions.length > 1) {
    return {
      kind: "error",
      message: [
        `1 段下のフォルダに .sln が複数あります。対象を決めて、次のような ${configName} を作ってから、もう一度実行してください:`,
        ...solutions.map((solution) => `  - ${solution}`),
        JSON.stringify({ target: solutions[0] }, null, 2),
      ].join("\n"),
    };
  }

  // VB.NET 以外のプロジェクト。git のリポジトリなら git が管理しているファイルを対象にする
  const result = initConfig(rootDir, deps, { gitRepository: findRepositoryRoot(rootDir, deps.exists) !== undefined });
  if (result.kind === "error") {
    return {
      kind: "error",
      message: [
        `.sln / .vbproj が直下にも 1 段下のフォルダにもありません。VB.NET のプロジェクトなら ${configName} に "target": "<フォルダ>/<名前>.sln" を書いてから、もう一度実行してください。`,
        `VB.NET 以外のプロジェクトの場合: ${result.message}`,
      ].join("\n"),
    };
  }
  if (result.kind === "kept") {
    return { kind: "ok", layout: "generic", lines: [`1. 構成: 既存の ${configName}(変更なし)`] };
  }
  if (result.roots.length === 0) {
    return {
      kind: "ok",
      layout: "generic",
      lines: [
        `1. 構成: generic(.sln / .vbproj が無いため、git が管理しているファイルを対象にする ${configName} を作りました)`,
        `   対象を絞るときは .repomixignore に除外を書くか、${configName} の extraRoots にディレクトリを書いてください`,
        `   VB.NET のプロジェクトで .sln が 2 段以上深い場合は見つけられません。kind の代わりに "target": "<パス>/<名前>.sln" を書いてください`,
      ],
    };
  }
  return {
    kind: "ok",
    layout: "generic",
    lines: [
      `1. 構成: generic(.sln / .vbproj が無いため ${configName} を作りました)`,
      ...result.roots.map((root) => `   extraRoots: ${root.path}/(kind: "${root.kind}")`),
      `   VB.NET のプロジェクトで .sln が 2 段以上深い場合は見つけられません。kind と extraRoots の代わりに "target": "<パス>/<名前>.sln" を書いてください`,
    ],
  };
}

function toRelative(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

/**
 * @param rootDir セットアップする場所(ルート)の絶対パス
 */
export function initProject(rootDir: string, deps: InitProjectDeps): InitProjectResult {
  const fail = (message: string, layout?: "solution" | "generic"): InitProjectResult => {
    deps.log(`[error] ${message}`);
    return layout === undefined ? { exitCode: 1 } : { exitCode: 1, layout };
  };

  if (!deps.isDirectory(rootDir)) {
    return fail(`ディレクトリがありません: ${rootDir}`);
  }
  const repositoryRoot = findRepositoryRoot(rootDir, deps.exists);
  if (repositoryRoot !== undefined && repositoryRoot !== rootDir && !hasConfigFile(rootDir, deps.isFile)) {
    return fail(
      [
        `ここはリポジトリの直下ではありません(リポジトリ: ${repositoryRoot})。`,
        `${TOOL_NAME} はリポジトリ直下(または設定ファイルの場所)を基準にパックを作り、変更を当てます。リポジトリ直下で npx ${TOOL_NAME} init を実行してください`,
        `(.sln がサブフォルダにあれば、init が ${CONFIG_FILE_NAME} の target に書きます)。`,
      ].join("\n"),
    );
  }
  deps.log(`セットアップ先: ${rootDir}`);

  // 1. 構成
  const layout = setUpLayout(rootDir, deps);
  if (layout.kind === "error") {
    return fail(layout.message);
  }
  for (const line of layout.lines) {
    deps.log(line);
  }

  // 2. docs/ 連携
  const docs = initDocs(rootDir, deps);
  const docsItems = [
    ...docs.created.map((item) => `作成 ${item}`),
    ...docs.kept.map((item) => `既存 ${item}`),
  ];
  deps.log(`2. docs/ 連携: ${docsItems.join(" / ")}`);
  if (docs.errors.length > 0) {
    return fail(docs.errors.join("\n"), layout.layout);
  }

  // 3. .gitignore(既存部分は書き換えず末尾に追記)。PC ごとの設定と適用の履歴(.tazuna/。旧版の
  // .petari/ だけがあればそれを使い続ける)も git の管理外にする
  const stateDirectory = stateDirectoryName(rootDir, deps.isDirectory);
  const gitignorePath = path.join(rootDir, ".gitignore");
  const gitignore = deps.readTextFile(gitignorePath);
  const plan = planGitignoreAppend(gitignore, [...GENERATED_OUTPUTS, `${stateDirectory}/`]);
  if (plan === undefined) {
    deps.log(`3. .gitignore: 生成物と ${stateDirectory}/ は除外済み(変更なし)`);
  } else {
    if (gitignore === undefined) {
      deps.writeTextFile(gitignorePath, plan.append);
    } else {
      deps.appendTextFile(gitignorePath, plan.append);
    }
    deps.log(`3. .gitignore: ${plan.added.join(" / ")} を追記しました`);
  }

  // 4. PC ごとの設定(Downloads の場所・VS Code のパスなど)
  const localConfig = `${stateDirectory}/config.json`;
  const localConfigPath = path.join(rootDir, stateDirectory, "config.json");
  if (deps.exists(localConfigPath)) {
    deps.log(`4. ${localConfig}: 既存(変更なし)`);
  } else {
    deps.makeDirectory(path.join(rootDir, stateDirectory));
    deps.writeTextFile(localConfigPath, CONFIG_TEMPLATE);
    deps.log(`4. ${localConfig}: 雛形を作りました(PC ごとの設定。git の管理外)`);
  }

  // 5. 規約文(内蔵。旧 init が書いた protocol.md は手を加えていなければ不要)
  const instruction = describeInstruction(resolveInstructionFile(undefined, rootDir, rootDir, deps));
  deps.log(`5. ${instruction.line}`);
  if (instruction.warning !== undefined) {
    deps.log(`   ${instruction.warning}`);
  }

  const command = (text: string): string => `  ${`npx ${text}`.padEnd(19)}`;
  deps.log("");
  deps.log("セットアップ完了。以後は次の 2 つだけです:");
  deps.log(`${command(PACK_COMMAND)}Copilot Chat に貼るものをクリップボードに入れる(本文に貼って送信)`);
  deps.log(`${command(`${TOOL_NAME} watch`)}別の端末で起動したままにすると、ダウンロードした changes.md を自動で適用`);
  deps.log(`${" ".repeat(21)}(起動しないときは、ダウンロードのたびに npx ${TOOL_NAME})`);
  if (layout.layout === "solution") {
    deps.log(`  ビルドは npx ${BUILD_COMMAND} で。失敗するとエラーと周辺のコードがクリップボードに入ります`);
  }
  deps.log(
    `${configFileNameIn(rootDir, deps.isFile)}・docs/ は git にコミットしてください(${stateDirectory}/ は PC ごとの設定と適用の履歴なのでコミットしません)。`,
  );
  return { exitCode: 0, layout: layout.layout };
}
