/**
 * petari pack — コードベースを AI チャットに渡す 1 ファイル(repomix 互換のパック)と、
 * チャット本文に貼る指示テキスト(.prompt.md)を作る(旧 slnmix)。
 *
 * .sln / .vbproj の論理構成(Link・DependentUpon 解決済み)か、設定ファイルの extraRoots に宣言した
 * ディレクトリ(kind: "generic")に基づく。解析・出力は src/pack/ のコアが担い、ここは引数処理とファイル I/O。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { INIT_COMMAND, PACK_COMMAND, TOOL_NAME } from "../brand.ts";
import { writeClipboardSync } from "../infra/clipboard.ts";
import { err } from "../infra/term.ts";
import { maskCredentials } from "../core/mask.ts";
import {
  DEFAULT_PROCEDURE_MODE,
  isProcedureMode,
  PROCEDURE_MODES,
  PROCEDURE_VERSION,
  renderBuiltinProcedure,
} from "../pack/assets/procedure.ts";
import { describeAutoTests, detectAutoTests } from "../pack/autoTests.ts";
import { describeDbSchema, resolveDbSchema } from "../pack/dbChecks.ts";
import { buildDesignerFileMatcher } from "../pack/designerFileFilter.ts";
import { decideMode, describeDocs, resolveDocs, type DocsResolution } from "../pack/docs.ts";
import { planHandoff } from "../pack/handoff.ts";
import { initConfig } from "../pack/initConfig.ts";
import { initDocs } from "../pack/initDocs.ts";
import { describeInstruction, resolveInstructionFile } from "../pack/instructionFile.ts";
import {
  assembleOutput,
  buildPromptText,
  type DocsTail,
  resolvePlan,
  resolveProcedure,
  resolveTask,
  type TaskResolution,
} from "../pack/procedureFile.ts";
import { buildRepomixOutput, type RepomixSource } from "../pack/services/repomixExporter.ts";
import { CONFIG_FILE_NAME, configFileNameIn, LEGACY_CONFIG_FILE_NAME, loadSlnmixConfig } from "../pack/slnmixConfig.ts";
import { parseSln } from "../pack/slnParser.ts";
import { parseVbproj } from "../pack/vbprojParser.ts";
import {
  createGitignoreEvaluator,
  FS_DEPS,
  isDirectoryPath,
  isFilePath,
  printDiagnostics,
  readSourceTextFile,
  resolveTargetAndRoot,
} from "./pack-io.ts";

export const PACK_USAGE = `使い方:
  ${PACK_COMMAND} [<solution.sln | project.vbproj | ディレクトリ>] [オプション]

  入力を省略するとカレントディレクトリ(ディレクトリ指定ならその直下)の
  *.sln を自動検出します(なければ *.vbproj。複数ある場合は候補を表示)。
  その場所の設定ファイル(${CONFIG_FILE_NAME}。旧名の ${LEGACY_CONFIG_FILE_NAME} も読みます)に
  "target": "dotnet/App.sln" があればそれを使います。同じ設定が "kind": "generic" なら
  .sln / .vbproj を探さず、extraRoots に宣言したディレクトリだけでパックします
  (VB.NET 以外のプロジェクト。${INIT_COMMAND} で作成)。

  ルート(<file path> の基準。設定ファイル・protocol.md・docs/・出力先もここ)は
  --root > 入力のディレクトリから上に向かって最初に見つかる設定ファイルの場所
  (.git のあるディレクトリより上には行かない)> 上に向かって最初の .git の場所 >
  入力と同じ場所、の順です(変更を当てる ${TOOL_NAME} と同じ決め方)。

オプション:
  -o, --output <file>   出力先(既定: ルートの repomix-output.xml)
      --root <dir>      ルートを明示する(入力はその配下にあること)
      --stdout          ファイルではなく標準出力へ書く(BOM なし)
      --include-designer  Designer 関連ファイル(*.Designer.vb 等)を原文のまま含める
      --include-designer-file <名前|パターン>
                        指定した Designer 関連ファイルだけ原文のまま含める
                        (複数指定可。* をワイルドカードに使える。ファイル名
                        または論理パスに全体一致)
      --no-ui-summary   Designer.vb からの UI サマリー(<ui_summary>)生成を無効化
      --no-mask         認証情報の自動マスク([MASKED] 置換)を無効化
      --no-strict-mask  高エントロピー文字列(ランダム英数字列)の機械的マスクを無効化
      --no-gitignore    .gitignore / .repomixignore による除外を無効化
      --legacy-paths    <file path> を旧形式(プロジェクト名\\論理パス)にする(廃止予定)
      --include-generated
                        生成コード(generatedDirs)の原文を含める(既定は除外し
                        <contract_summary> で代替)
      --instruction-file <path>
                        出力末尾に <instruction> として連結する規約文ファイルを明示指定
                        (既定: 内蔵の規約文。ルートに protocol.md を置くとそれを使う)
      --no-instruction  規約文(<instruction>)を出さない
      --task <file|text>  依頼内容を <task> として同梱する。ファイルが存在すれば
                        読み込み、なければ文字列として扱う
      --mode <full|plan|implement|design>
                        作業手順(<procedure>)のモード(既定: full。docs 連携時は
                        文書の状態から自動選択)
      --design <名前|file>
                        design モードで対象の設計書を指定
      --init-docs       docs/ 連携だけを設定する(${INIT_COMMAND} に含まれる)
      --init-config     VB.NET 以外のプロジェクト向けの ${CONFIG_FILE_NAME}
                        (kind: "generic")だけを作る(${INIT_COMMAND} に含まれる)
      --plan <file>     implement モードで承認済みの方針を <plan> として同梱する
      --procedure-file <path>
                        作業手順文を明示指定(既定: ルートの procedure.md。なければ内蔵既定文)
      --no-procedure    <procedure> を出さない
      --print-procedure 内蔵の作業手順文を標準出力に書いて終了(--mode 併用可)
      --prompt-output <file>
                        チャット本文に貼る指示テキストの出力先(既定: パックと同じ場所の
                        <出力名>.prompt.md。--stdout のときは指定時のみ書く)
      --no-prompt       本文用の指示テキストを書かない
      --print-prompt    本文用の指示テキストを標準出力に書いて終了(パックは作らない)
      --no-clip         Copilot Chat に貼るものをクリップボードに入れない

M365 Copilot Chat への渡し方:
  実行後、貼るものがクリップボードに入っています(--no-clip で無効)。
  パックが約 120K 文字以内ならパック全体が入るので、本文に貼って送信するだけ。
  超えるときは本文用テキスト(<出力名>.prompt.md と同じ)が入るので、パック
  (repomix-output.xml)を添付し、本文に貼って送信する。添付ファイル内の指示は
  Copilot が「埋め込み指示」として無視するため、手順文・規約文は本文側で渡す
`;

/**
 * M365 Copilot Chat の入力欄に貼れる上限の目安(文字)。超えると送信ボタンが
 * 非活性になる(2026-09-12 実測: 約 120K 文字。設計書 §15.1)
 */
const PASTE_LIMIT_CHARS = 120_000;

/** パックの出力パスから本文用テキストの既定パスを作る(拡張子を .prompt.md に) */
function defaultPromptPath(outputPath: string): string {
  const ext = path.extname(outputPath);
  const base = ext === "" ? outputPath : outputPath.slice(0, -ext.length);
  return `${base}.prompt.md`;
}

/** 入力(.sln / .vbproj)から RepomixSource[] を組み立てる */
function collectSources(targetPath: string): RepomixSource[] {
  const content = readSourceTextFile(targetPath);
  if (content === undefined) {
    throw new Error(`ファイルを読み込めません: ${targetPath}`);
  }

  if (/\.sln$/i.test(targetPath)) {
    const slnResult = parseSln(content, targetPath, FS_DEPS);
    printDiagnostics(path.basename(targetPath), slnResult.diagnostics);
    const sources: RepomixSource[] = [];
    for (const project of slnResult.projects) {
      if (!project.exists) {
        err(`[warning] プロジェクトが見つかりません(スキップ): ${project.absolutePath}`);
        continue;
      }
      const xml = readSourceTextFile(project.absolutePath);
      if (xml === undefined) {
        err(`[error] プロジェクトを読み込めません(スキップ): ${project.absolutePath}`);
        continue;
      }
      const parseResult = parseVbproj(xml, project.absolutePath, FS_DEPS);
      printDiagnostics(project.name, parseResult.diagnostics);
      sources.push({ label: project.name, parseResult });
    }
    return sources;
  }

  const parseResult = parseVbproj(content, targetPath, FS_DEPS);
  const label = path.basename(targetPath).replace(/\.vbproj$/i, "");
  printDiagnostics(label, parseResult.diagnostics);
  return [{ label, parseResult }];
}

export function packCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "include-designer": { type: "boolean", default: false },
      "include-designer-file": { type: "string", multiple: true },
      "no-ui-summary": { type: "boolean", default: false },
      "no-mask": { type: "boolean", default: false },
      "no-strict-mask": { type: "boolean", default: false },
      "no-gitignore": { type: "boolean", default: false },
      "legacy-paths": { type: "boolean", default: false },
      root: { type: "string" },
      "include-generated": { type: "boolean", default: false },
      "instruction-file": { type: "string" },
      task: { type: "string" },
      mode: { type: "string" },
      design: { type: "string" },
      "init-docs": { type: "boolean", default: false },
      "init-config": { type: "boolean", default: false },
      plan: { type: "string" },
      "procedure-file": { type: "string" },
      "no-procedure": { type: "boolean", default: false },
      "no-instruction": { type: "boolean", default: false },
      "print-procedure": { type: "boolean", default: false },
      "prompt-output": { type: "string" },
      "no-prompt": { type: "boolean", default: false },
      "print-prompt": { type: "boolean", default: false },
      "no-clip": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(PACK_USAGE);
    return 0;
  }

  const explicitMode = values.mode;
  if (explicitMode !== undefined && !isProcedureMode(explicitMode)) {
    err(`--mode は ${PROCEDURE_MODES.join(" / ")} のいずれかを指定してください: ${explicitMode}`);
    return 1;
  }
  if (values["print-procedure"]) {
    // カレント(または --root)の設定が kind: "generic" なら generic 向けの文面にする
    const printRoot = path.resolve(process.cwd(), values.root ?? ".");
    const printConfig = loadSlnmixConfig(printRoot, { readTextFile: readSourceTextFile });
    process.stdout.write(
      renderBuiltinProcedure(explicitMode ?? DEFAULT_PROCEDURE_MODE, {
        docs: "placeholder",
        tests: "placeholder",
        db: "placeholder",
        layout: printConfig.config.kind,
      }),
    );
    return 0;
  }
  if (explicitMode === "implement" && values.plan === undefined) {
    err(
      "--mode implement には --plan <file>(承認済みの方針)が必要です。先に --mode plan で方針を出し、確認したものを渡してください。",
    );
    return 1;
  }
  if (explicitMode !== "implement" && values.plan !== undefined) {
    err("--plan は --mode implement でのみ使えます。");
    return 1;
  }

  // VB.NET 以外のプロジェクト向けの設定ファイルを作る(入力の解決より前。.sln は無い前提)
  if (values["init-config"]) {
    const initRoot = path.resolve(process.cwd(), values.root ?? positionals[0] ?? ".");
    const result = initConfig(initRoot, {
      isDirectory: isDirectoryPath,
      isFile: isFilePath,
      listFileNames: FS_DEPS.listFileNames,
      writeTextFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    });
    if (result.kind === "error") {
      err(result.message);
      return 1;
    }
    if (result.kind === "kept") {
      err(`既存: ${result.path}(変更なし)`);
      return 0;
    }
    err(`作成: ${result.path}`);
    for (const root of result.roots) {
      err(`  extraRoots: ${root.path}/(kind: "${root.kind}")`);
    }
    err(
      `以後は同じ場所で npx ${PACK_COMMAND} を実行すると、extraRoots のディレクトリだけでパックと本文用テキストを作ります。対象を増やすときは extraRoots に path を追記してください。`,
    );
    return 0;
  }

  if (positionals.length > 1) {
    err(`${PACK_COMMAND} に渡せる入力は 1 つだけです。`);
    return 1;
  }
  const resolved = resolveTargetAndRoot(positionals[0], values.root, { legacyPaths: values["legacy-paths"] });
  if (resolved.kind === "error") {
    err(resolved.message);
    if (resolved.usageHint) {
      err(`\n使い方は ${PACK_COMMAND} --help を参照してください。`);
    }
    return 1;
  }
  const { targetPath, rootDir } = resolved;

  // docs/ 連携の初回セットアップ(パックは作らない)
  if (values["init-docs"]) {
    const result = initDocs(rootDir, {
      exists: (p) => fs.existsSync(p),
      readTextFile: readSourceTextFile,
      writeTextFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
      makeDirectory: (p) => fs.mkdirSync(p, { recursive: true }),
    });
    for (const item of result.created) {
      err(`作成: ${item}`);
    }
    for (const item of result.kept) {
      err(`既存: ${item}(変更なし)`);
    }
    for (const message of result.errors) {
      err(`[error] ${message}`);
    }
    if (result.errors.length === 0) {
      err(
        `docs/ 連携を有効にしました。以後は npx ${PACK_COMMAND} を実行するだけで、文書の状態に応じたモードでパックと本文用テキストを作ります。`,
      );
    }
    return result.errors.length === 0 ? 0 : 1;
  }

  const sources = targetPath === undefined ? [] : collectSources(targetPath);
  if (targetPath !== undefined && sources.length === 0) {
    err("出力対象のプロジェクトがありません。");
    return 1;
  }

  // Designer の含め方: --include-designer-file(選択)> --include-designer(全件)
  // (generic 構成では Designer が無いので指定は無視する)
  const designerFilePatterns = values["include-designer-file"] ?? [];
  let includeSensitive: boolean | ((logicalPath: string) => boolean) = values["include-designer"];
  if (targetPath === undefined && (designerFilePatterns.length > 0 || values["include-designer"])) {
    err('[warning] kind: "generic" の構成では --include-designer / --include-designer-file は無視します');
  } else if (designerFilePatterns.length > 0) {
    if (values["include-designer"]) {
      err("[warning] --include-designer-file の指定があるため --include-designer(全件)は無視します");
    }
    includeSensitive = buildDesignerFileMatcher(designerFilePatterns);
    // パターンの打ち間違いに気づけるよう、どの Designer にも一致しなければ警告する
    const sensitivePaths = sources.flatMap((source) =>
      source.parseResult.items.filter((item) => item.isSensitive).map((item) => item.logicalPath),
    );
    for (const pattern of designerFilePatterns) {
      if (!sensitivePaths.some(buildDesignerFileMatcher([pattern]))) {
        err(`[warning] --include-designer-file に一致する Designer 関連ファイルがありません: ${pattern}`);
      }
    }
  }

  // 設定ファイルはルートから読む(物理パス・protocol.md / procedure.md・.gitignore・docs/ も同じ基準)
  const configResult = loadSlnmixConfig(rootDir, { readTextFile: readSourceTextFile });
  const configName = configFileNameIn(rootDir, isFilePath);
  printDiagnostics(configName, configResult.diagnostics);
  const config = configResult.config;
  const layout = targetPath === undefined ? "generic" : "solution";
  if (layout === "generic" && config.extraRoots.length === 0) {
    err(
      `出力対象のディレクトリがありません。${configName} の extraRoots に少なくとも 1 つ path を書いてください(例: { "path": "src", "kind": "src" })。`,
    );
    return 1;
  }
  if (layout === "solution" && config.kind === "generic") {
    err(
      `[warning] ${configName} は kind: "generic" ですが、入力に .sln / .vbproj が指定されたため従来どおり論理構成で出力します`,
    );
  }
  if (config.sources.length > 0) {
    const parts = [`extraRoots ${config.extraRoots.length} 件`];
    if (config.contractSchema !== undefined) {
      parts.push(`契約スキーマ ${config.contractSchema}`);
    }
    if (config.generatedDirs.length > 0) {
      parts.push(`生成コード ${config.generatedDirs.length} ディレクトリ`);
    }
    err(`設定: ${config.sources.join(", ")}(${parts.join(" / ")})`);
  }

  // .gitignore / .repomixignore の尊重(本家 repomix と同じ既定挙動)
  const gitignore = createGitignoreEvaluator(rootDir);

  // パック本文を先に組み立てる。手順文の「自動テスト」の節は、実際に出力する
  // ファイル一覧(と extraRoots の kind)から有無を判定するため(autoTests.ts)
  const output = buildRepomixOutput(
    targetPath === undefined ? path.basename(rootDir) : path.basename(targetPath),
    sources,
    {
      readTextFile: readSourceTextFile,
      ignoreReasonFor: values["no-gitignore"] ? undefined : (absolutePath) => gitignore.ignoreReasonFor(absolutePath),
      listFilesRecursive: FS_DEPS.listFilesRecursive,
    },
    {
      includeSensitive,
      maskCredentials: !values["no-mask"],
      strictMask: !values["no-strict-mask"],
      uiSummary: !values["no-ui-summary"],
      rootDir: values["legacy-paths"] ? undefined : rootDir,
      extraRoots: config.extraRoots,
      configFileName: configName,
      contractSchema: config.contractSchema,
      contractFile: config.contractFile,
      generatedDirs: config.generatedDirs,
      includeGenerated: values["include-generated"],
      layout,
    },
  );
  printDiagnostics("出力", output.diagnostics);
  if (layout === "generic" && output.fileCount === 0) {
    err(
      `出力対象のファイルがありません(extraRoots の include / exclude と .gitignore を確認してください。除外の理由は --stdout の <skipped_files> に出ます)。`,
    );
    return 1;
  }

  // docs/ 連携: 文書を読み、作業モードと既定タスクを決める
  let docs: DocsResolution | undefined;
  let docsTail: DocsTail | undefined;
  let mode = explicitMode ?? DEFAULT_PROCEDURE_MODE;
  let modeReason = explicitMode === undefined ? "既定" : "指定";
  let defaultTask: string | undefined;
  if (config.docs !== undefined) {
    docs = resolveDocs(rootDir, config.docs, {
      readTextFile: readSourceTextFile,
      listFileNames: FS_DEPS.listFileNames,
    });
    printDiagnostics("docs", docs.diagnostics);
    err(`文書: ${describeDocs(docs)}`);
    const decided = decideMode(docs, {
      ...(explicitMode === undefined ? {} : { explicitMode }),
      ...(values.design === undefined ? {} : { designArg: values.design }),
    });
    if (decided.kind === "error") {
      err(decided.message);
      return 1;
    }
    mode = decided.decision.mode;
    modeReason = decided.decision.reason;
    defaultTask = decided.decision.defaultTask;
    const strict = !values["no-strict-mask"];
    docsTail = {
      docs,
      decision: decided.decision,
      ...(values["no-mask"]
        ? {}
        : {
            transform: (text: string) => maskCredentials(text, { vbSource: false, strict }).content,
          }),
    };
  } else if (explicitMode === "design" || values.design !== undefined) {
    err(`--mode design / --design には docs/ 連携が必要です。先に npx ${PACK_COMMAND} --init-docs を実行してください。`);
    return 1;
  }
  err(`モード: ${mode}(${modeReason})`);

  // 自動テストの有無(手順文 v6 の「自動テスト」の節を入れるか)。テストが無い
  // プロジェクトでは手順文は v5 と同一
  const autoTests = detectAutoTests(output.filePaths, config.extraRoots);
  err(`自動テスト: ${describeAutoTests(autoTests)}`);

  // DB の確認・動作検証(手順文 v8 / v9): ルートの docs/db/schema.md(ashiato schema の出力)が
  // あればパックに <db_schema> を入れ、手順文に「DB の確認」「動作検証」の節を足す。無ければ従来と同一
  const dbSchema = resolveDbSchema(rootDir, { readTextFile: readSourceTextFile });
  err(`DB の確認・動作検証: ${describeDbSchema(dbSchema)}`);

  // 規約文を出力末尾へ連結する(内蔵。ルートの protocol.md は置いたときだけ使う上書き)
  if (values["no-instruction"] && values["instruction-file"] !== undefined) {
    err("--no-instruction と --instruction-file は同時に使えません。");
    return 1;
  }
  const instruction = resolveInstructionFile(
    values["instruction-file"],
    rootDir,
    process.cwd(),
    { readTextFile: readSourceTextFile },
    values["no-instruction"],
  );
  if (instruction.kind === "error") {
    err(instruction.message);
    return 1;
  }

  // 作業手順(<procedure>)・依頼内容(<task>)・承認済み方針(<plan>)
  const textDeps = { readTextFile: readSourceTextFile };
  let task: TaskResolution = resolveTask(values.task, process.cwd(), textDeps);
  if (task.kind === "none" && defaultTask !== undefined) {
    task = { kind: "default", content: defaultTask };
  }
  const plan = resolvePlan(values.plan, process.cwd(), textDeps);
  if (plan.kind === "error") {
    err(plan.message);
    return 1;
  }
  const procedure = resolveProcedure(
    {
      explicitPath: values["procedure-file"],
      disabled: values["no-procedure"],
      mode,
      docs: docs !== undefined,
      tests: autoTests.present,
      db: dbSchema !== undefined,
      layout,
    },
    rootDir,
    process.cwd(),
    textDeps,
  );
  if (procedure.kind === "error") {
    err(procedure.message);
    return 1;
  }

  // パックの出力先(--stdout のときはファイル名の表示用にのみ使う)
  const outputPath = path.resolve(values.output ?? path.join(rootDir, "repomix-output.xml"));
  const promptTail = {
    task,
    plan,
    procedure,
    instruction,
    ...(docsTail === undefined ? {} : { docs: docsTail }),
    ...(dbSchema === undefined
      ? {}
      : {
          dbSchema,
          ...(values["no-mask"]
            ? {}
            : {
                dbSchemaTransform: (text: string) =>
                  maskCredentials(text, { vbSource: false, strict: !values["no-strict-mask"] }).content,
              }),
        }),
  };
  const promptText = buildPromptText(promptTail, path.basename(outputPath));
  if (values["print-prompt"]) {
    if (promptText === undefined) {
      err("本文に貼る指示がありません(--no-procedure かつ --task なし、--no-instruction)。");
      return 1;
    }
    process.stdout.write(promptText);
    return 0;
  }

  // 末尾に <task> / <plan> / <procedure> / <instruction>、先頭にリマインダの
  // サンドイッチ配置(チャットの要約処理で末尾が落ちても冒頭が末尾へ誘導する)
  const content = assembleOutput(output.content, promptTail);
  const instructionNote = describeInstruction(instruction);
  err(instructionNote.line);
  if (instructionNote.warning !== undefined) {
    err(instructionNote.warning);
  }
  if (task.kind === "file") {
    err(`タスク: ${task.path}`);
  } else if (task.kind === "text") {
    err(`タスク: 引数の文字列(${task.content.length} 文字)`);
  } else if (task.kind === "default") {
    err(`タスク: 既定(${task.content})`);
  }
  if (plan.kind === "found") {
    err(`方針: ${plan.path}`);
  }
  if (procedure.kind === "builtin") {
    err(`手順文: 内蔵既定文 v${PROCEDURE_VERSION}(モード: ${procedure.mode})`);
  } else if (procedure.kind === "file") {
    err(`手順文: ${procedure.path}(モード: ${procedure.mode})`);
  }

  if (values.stdout) {
    process.stdout.write(content);
  } else {
    // BOM 付き UTF-8 で保存(Windows 系ツールのエンコーディング誤判定を防ぐ)
    fs.writeFileSync(outputPath, "﻿" + content, "utf8");
    err(`出力: ${outputPath}`);
  }

  // チャット本文に貼る指示テキスト。添付ファイル内の指示は Copilot が無視するため、
  // 手順文・規約文はこちらを本文に貼ってもらう(--stdout のときは明示指定時のみ)
  let promptPath: string | undefined;
  if (promptText !== undefined && !values["no-prompt"] && (!values.stdout || values["prompt-output"] !== undefined)) {
    promptPath = path.resolve(values["prompt-output"] ?? defaultPromptPath(outputPath));
    fs.writeFileSync(promptPath, "﻿" + promptText, "utf8");
    err(`本文用: ${promptPath}`);
  }

  const maskNote = values["no-mask"] ? "(マスク無効)" : ` / 認証情報マスク ${output.maskedCount} 件`;
  const uiSummaryNote = output.uiSummaryCount > 0 ? ` / UI サマリー ${output.uiSummaryCount} 件` : "";
  const extraNote = output.extraRootFileCount > 0 ? ` / 追加ルート ${output.extraRootFileCount} 件` : "";
  const contractNote = output.contractSummaryIncluded ? " / 契約サマリーあり" : "";
  err(
    `${output.fileCount} ファイル / 約 ${Math.max(1, Math.round(output.totalChars / 1000))}K 文字(スキップ ${output.skipped.length} 件${maskNote}${uiSummaryNote}${extraNote}${contractNote})`,
  );

  // Copilot Chat への受け渡し。貼るものをクリップボードに入れておく(設計書 §21)
  const handoff = planHandoff(content, promptText, PASTE_LIMIT_CHARS);
  const clipped =
    !values.stdout && !values["no-clip"] && handoff.kind !== "none" ? writeClipboardSync(handoff.text) : undefined;
  if (clipped !== undefined && !clipped.ok) {
    err(`[warning] クリップボードにコピーできませんでした(${clipped.message})`);
  }
  const limitNote = `貼付上限の目安(約 ${PASTE_LIMIT_CHARS / 1000}K 文字)`;
  if (clipped?.ok === true && handoff.kind === "paste-pack") {
    err(
      `パックが${limitNote}以内なので、パック全体をクリップボードにコピーしました → Copilot Chat の本文に貼って送信してください(添付は不要)`,
    );
  } else if (clipped?.ok === true && handoff.kind === "paste-prompt") {
    err(
      `パックは${limitNote}を超えています → ${path.basename(outputPath)} を添付し、クリップボードにコピーした本文用テキストを本文に貼って送信してください`,
    );
  } else {
    // クリップボードを使わない(--no-clip / --stdout / 失敗)ときは従来の案内
    if (content.length > PASTE_LIMIT_CHARS) {
      err(`パックは${limitNote}を超えています → Copilot Chat には添付で渡してください`);
    } else {
      err(`パックは${limitNote}以内です → 本文に貼れば全文がコンテキストに入ります`);
    }
    if (promptPath !== undefined) {
      err(`添付で渡す場合は ${path.basename(promptPath)} の内容を本文に貼ってください(添付内の指示は Copilot が無視します)`);
    }
  }
  if (promptText !== undefined && promptText.length > PASTE_LIMIT_CHARS) {
    err(
      `[warning] 本文用テキストが約 ${Math.round(promptText.length / 1000)}K 文字で貼付上限の目安を超えています。設計書・引継ぎ書を分割するか、--no-mask 以外の方法で短くしてください`,
    );
  }
  return 0;
}

