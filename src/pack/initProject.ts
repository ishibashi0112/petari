/**
 * slnmix init: 初回セットアップを 1 コマンドにまとめる(v0.18.0、設計書 §20)。
 *
 * 1. 構成: slnmix.config.json があればそのまま使う。なければ
 *    - 直下に .sln / .vbproj があれば設定を作らない(従来どおり自動検出)
 *    - 直下に無く、1 段下のフォルダに .sln が 1 つだけあれば target で指す設定を作る
 *    - どちらも無ければ --init-config と同じ generic 構成を作る
 * 2. docs/ 連携(--init-docs と同じ)
 * 3. .gitignore に生成物(repomix-output.xml / repomix-output.prompt.md)を追記
 * 4. petari init --yes --no-repomix(protocol.md / .petari/ / .gitignore の .petari/)
 *
 * 実行場所はリポジトリ直下(.git のある場所)に限る。petari は .git の場所を基準に
 * changes.md のパスを当てるため、slnmix のルートと食い違うと適用先がずれる。
 * 既存のファイルは変えない(protocol.md だけは petari が最新の規約文に更新する)。
 * 何度実行しても同じ結果になる(冪等)。
 *
 * 1 段下の .sln を探すのは init だけの例外(パックの対象は決めず、見つけた .sln を
 * 設定に書いて利用者に見える形にする)。
 *
 * ファイルシステムと petari の起動は deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { GitignoreRules } from "./services/gitignoreMatcher.ts";
import { initConfig, type InitConfigDeps } from "./initConfig.ts";
import { initDocs, type InitDocsDeps } from "./initDocs.ts";
import { CONFIG_FILE_NAME, loadSlnmixConfig } from "./slnmixConfig.ts";
import { resolveTarget } from "./targetResolver.ts";

/** output は petari の端末出力(手順 4 の下に字下げして表示する) */
export type PetariInitOutcome =
  | { ok: true; output: string }
  | { ok: false; message: string; output: string };

export interface InitProjectDeps extends InitDocsDeps, InitConfigDeps {
  /** ディレクトリ直下のサブディレクトリ名一覧(取得できなければ undefined) */
  listDirectoryNames(absolutePath: string): string[] | undefined;
  /** 既存ファイルの末尾に追記する(.gitignore の既存部分のバイト列を変えないため) */
  appendTextFile(absolutePath: string, content: string): void;
  /** petari init --yes --no-repomix --root <rootDir> を実行する */
  runPetariInit(rootDir: string): PetariInitOutcome;
  log(line: string): void;
}

export interface InitProjectResult {
  exitCode: number;
  /** 決まった構成(手順 1 で止まったときは undefined) */
  layout?: "solution" | "generic" | undefined;
}

/** slnmix が書く生成物(既定の出力名)。git の管理外にする */
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
  const added = entries.filter((entry) => !matcher.ignores(entry));
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
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  const configText = deps.readTextFile(configPath);
  if (configText !== undefined) {
    try {
      JSON.parse(configText.replace(/^﻿/, ""));
    } catch (error) {
      return {
        kind: "error",
        message: `${CONFIG_FILE_NAME} を JSON として読めません(上書きしません): ${
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
        lines: [`1. 構成: generic(既存の ${CONFIG_FILE_NAME}。変更なし)`],
      };
    }
    if (resolution.kind === "file") {
      return {
        kind: "ok",
        layout: "solution",
        lines: [
          `1. 構成: ${toRelative(rootDir, resolution.path)}(既存の ${CONFIG_FILE_NAME}。変更なし)`,
        ],
      };
    }
    const hasDirectTarget = (deps.listFileNames(rootDir) ?? []).some((name) => TARGET_EXTENSION.test(name));
    if (config.target === undefined && !hasDirectTarget) {
      return {
        kind: "error",
        message: [
          `${CONFIG_FILE_NAME} はありますが、対象が決まりません(直下に .sln / .vbproj が無く、target も kind: "generic" もありません)。`,
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
          ? `${resolution.message}\n${CONFIG_FILE_NAME} に "target": "<対象>.sln" を書いてから、もう一度実行してください。`
          : "対象を決められません。",
    };
  }

  // .sln がサブフォルダにある構成(例: dotnet/App.sln)。target で指せばルートは
  // ここ(= petari のルート)のまま
  const solutions = findSolutionsOneLevelDown(rootDir, deps);
  if (solutions.length === 1) {
    const target = solutions[0];
    deps.writeTextFile(configPath, `${JSON.stringify({ target }, null, 2)}\n`);
    return {
      kind: "ok",
      layout: "solution",
      lines: [`1. 構成: ${target}(1 段下で見つけた .sln を ${CONFIG_FILE_NAME} の target に書きました)`],
    };
  }
  if (solutions.length > 1) {
    return {
      kind: "error",
      message: [
        "1 段下のフォルダに .sln が複数あります。対象を決めて、次のような slnmix.config.json を作ってから、もう一度実行してください:",
        ...solutions.map((solution) => `  - ${solution}`),
        JSON.stringify({ target: solutions[0] }, null, 2),
      ].join("\n"),
    };
  }

  // VB.NET 以外のプロジェクト
  const result = initConfig(rootDir, deps);
  if (result.kind === "error") {
    return {
      kind: "error",
      message: [
        `.sln / .vbproj が直下にも 1 段下のフォルダにもありません。VB.NET のプロジェクトなら ${CONFIG_FILE_NAME} に "target": "<フォルダ>/<名前>.sln" を書いてから、もう一度実行してください。`,
        `VB.NET 以外のプロジェクトの場合: ${result.message}`,
      ].join("\n"),
    };
  }
  if (result.kind === "kept") {
    return { kind: "ok", layout: "generic", lines: [`1. 構成: 既存の ${CONFIG_FILE_NAME}(変更なし)`] };
  }
  return {
    kind: "ok",
    layout: "generic",
    lines: [
      `1. 構成: generic(.sln / .vbproj が無いため ${CONFIG_FILE_NAME} を作りました)`,
      ...result.roots.map((root) => `   extraRoots: ${root.path}/(kind: "${root.kind}")`),
      `   VB.NET のプロジェクトで .sln が 2 段以上深い場合は見つけられません。kind と extraRoots の代わりに "target": "<パス>/<名前>.sln" を書いてください`,
    ],
  };
}

function toRelative(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

/**
 * @param rootDir セットアップする場所(リポジトリ直下)の絶対パス
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
  if (repositoryRoot !== undefined && repositoryRoot !== rootDir) {
    return fail(
      [
        `ここはリポジトリの直下ではありません(リポジトリ: ${repositoryRoot})。`,
        "petari はリポジトリ直下を基準に変更を当てるため、slnmix もそこに揃えます。リポジトリ直下で npx slnmix init を実行してください",
        "(.sln がサブフォルダにあれば、init が slnmix.config.json の target に書きます)。",
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

  // 3. .gitignore(既存部分は書き換えず末尾に追記)
  const gitignorePath = path.join(rootDir, ".gitignore");
  const gitignore = deps.readTextFile(gitignorePath);
  const plan = planGitignoreAppend(gitignore, GENERATED_OUTPUTS);
  if (plan === undefined) {
    deps.log("3. .gitignore: 生成物は除外済み(変更なし)");
  } else {
    if (gitignore === undefined) {
      deps.writeTextFile(gitignorePath, plan.append);
    } else {
      deps.appendTextFile(gitignorePath, plan.append);
    }
    deps.log(`3. .gitignore: ${plan.added.join(" / ")} を追記しました`);
  }

  // 4. petari(規約文 protocol.md と .petari/)
  deps.log("4. petari の初期化(petari init --yes --no-repomix):");
  const petari = deps.runPetariInit(rootDir);
  for (const line of petari.output.split(/\r?\n/)) {
    if (line.trim() !== "") {
      deps.log(`   ${line}`);
    }
  }
  if (!petari.ok) {
    return fail(
      `petari の初期化に失敗しました: ${petari.message}\nこのフォルダで npx petari init --yes --no-repomix を実行してください(1〜3 は完了しています)。`,
      layout.layout,
    );
  }

  deps.log("");
  deps.log("セットアップ完了。以後は次の 2 つだけです:");
  deps.log("  npx slnmix         Copilot Chat に貼るものをクリップボードに入れる(本文に貼って送信)");
  deps.log("  npx petari watch   別の端末で起動したままにすると、ダウンロードした changes.md を自動で適用");
  deps.log("                     (起動しないときは、ダウンロードのたびに npx petari)");
  if (layout.layout === "solution") {
    deps.log("  ビルドは npx slnmix build で。失敗するとエラーと周辺のコードがクリップボードに入ります");
  }
  deps.log("slnmix.config.json・docs/・protocol.md は git にコミットしてください。");
  return { exitCode: 0, layout: layout.layout };
}
