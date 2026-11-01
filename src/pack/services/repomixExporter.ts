/**
 * Repomix 形式エクスポート。
 *
 * 解析済みの ProjectItem[](Link 解決済みの論理構成)をもとに、
 * AI に渡しやすい 1 ファイルのテキスト(repomix の XML スタイル)を生成する。
 * ディレクトリ走査ではなく .sln / .vbproj の論理構成に基づくのが特徴。
 *
 * - 文字コードはレガシー VB で多い Shift_JIS(CP932)を自動判定して UTF-8 へ統一
 * - EmbeddedResource(.resx)は常に除外、Designer 関連は既定で除外(オプションで含める)
 * - 除外・未解決のファイルは skipped_files に明記する(黙って捨てない)
 * - <file path> は既定でルート相対の物理パス(`/` 区切り)。petari 等の
 *   適用ツールがそのまま使える形にする。<directory_structure> は従来どおり
 *   論理ツリー(人が読む用)。rootDir を渡さなければ従来の
 *   `プロジェクト名\論理パス` 表記(--legacy-paths)
 * - slnmix.config.json の extraRoots(web / 契約ディレクトリ)を同じパックへ
 *   入れ、生成コードは除外して <contract_summary> で代替する
 *
 * ファイル読み込みは deps 注入とし、純粋ロジックに保つ。
 */

import * as path from "node:path";
import { buildLogicalTree } from "../logicalTreeBuilder.ts";
import { TOOL_NAME } from "../../brand.ts";
import { CONFIG_FILE_NAME, type ExtraRootConfig } from "../slnmixConfig.ts";
import type {
  FileNode,
  LegacyTreeNode,
  ParseDiagnostic,
  VbprojParseResult,
} from "../types.ts";
import { isBinaryExtension } from "./binaryExtensions.ts";
import { summarizeContractSchema } from "./contractSummary.ts";
import { decodeShiftJis } from "../../core/encoding.ts";
import { type MaskFinding, maskCredentials } from "../../core/mask.ts";
import {
  parseDesignerVb,
  renderDesignerControlLines,
} from "./designerSummary.ts";
import {
  collectExtraRoots,
  type ExtraRootFile,
  type ExtraRootsResult,
} from "./extraRootsCollector.ts";

export interface RepomixSource {
  /** 表示名(.sln 上のプロジェクト名など)。ツリーとパスの先頭に使う */
  label: string;
  parseResult: VbprojParseResult;
}

export interface RepomixExportDeps {
  /** ファイルを読み UTF-8 文字列で返す(失敗時 undefined)。エンコーディング変換は呼び出し側 */
  readTextFile(absolutePath: string): string | undefined;
  /**
   * .gitignore / .repomixignore による除外判定(本家 repomix と同じ挙動)。
   * 除外対象なら根拠の ignore ファイルパスを返す。未指定なら判定しない
   */
  ignoreReasonFor?: ((absolutePath: string) => string | undefined) | undefined;
  /**
   * extraRoots(slnmix.config.json)の走査用。ディレクトリ配下の全ファイルの
   * 絶対パス(再帰)。未指定なら extraRoots は扱えない(スキップ一覧に明記)
   */
  listFilesRecursive?(absoluteDir: string): string[] | undefined;
}

export interface RepomixExportOptions {
  /**
   * Designer 関連(*.Designer.vb / *.resx 除く自動生成系)を含めるか。
   * boolean は全件一括の指定。述語を渡すと論理パス(プロジェクト名を含まない
   * `\` 区切り)ごとに判定し、true を返したファイルだけ原文を含める。
   * 含めなかった Designer.vb は従来どおりスキップ + <ui_summary> 要約の対象
   */
  includeSensitive: boolean | ((logicalPath: string) => boolean);
  /** 認証情報らしき値を [MASKED] に自動置換するか */
  maskCredentials: boolean;
  /**
   * 高エントロピー文字列(ランダムな英数字列)も機械的にマスクするか。
   * 省略時は true(厳格モードが既定)。maskCredentials が false のときは
   * 使われない
   */
  strictMask?: boolean | undefined;
  /**
   * Designer 原文を含めない場合に、*.Designer.vb からコントロール構成を
   * 要約した <ui_summary> を埋め込むか(既定 true)。
   * includeSensitive が true のとき(原文が含まれるとき)は使われない
   */
  uiSummary?: boolean | undefined;
  /**
   * 物理パス化の基準ディレクトリ(ルート。通常は .sln のある場所)の絶対パス。
   * 指定すると <file path> がルート相対の物理パス(`/` 区切り)になる。
   * 未指定なら従来の `プロジェクト名\論理パス` 表記(後方互換 / --legacy-paths)
   */
  rootDir?: string | undefined;
  /** .vbproj に乗らない追加ディレクトリ(rootDir 必須。設定ファイルの extraRoots) */
  extraRoots?: readonly ExtraRootConfig[] | undefined;
  /** 設定ファイルの名前(ヘッダーの説明用。既定は新しい名前。旧名の slnmix.config.json のときはそれ) */
  configFileName?: string | undefined;
  /** contract.schema.json のルート相対パス(rootDir 必須)。あれば <contract_summary> を生成 */
  contractSchema?: string | undefined;
  /** 契約の正本ファイルのルート相対パス(<contract_summary> の説明に使う) */
  contractFile?: string | undefined;
  /** 生成コードのディレクトリ(ルート相対)。既定で除外して <contract_summary> で代替 */
  generatedDirs?: readonly string[] | undefined;
  /** 生成コードの原文を含める(--include-generated) */
  includeGenerated?: boolean | undefined;
  /**
   * 構成の種類(既定 "solution")。"generic" は .sln / .vbproj を使わず extraRoots
   * だけでパックする(sources は空。rootDir 必須)。ヘッダーの説明文から
   * Visual Studio / Designer / .resx 等の VB 固有の記述を外す。"solution" の
   * 出力は従来と同一
   */
  layout?: "solution" | "generic" | undefined;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface MaskedFile {
  path: string;
  findings: MaskFinding[];
}

export interface RepomixExportResult {
  content: string;
  fileCount: number;
  totalChars: number;
  skipped: SkippedFile[];
  /** マスクを行ったファイルと箇所の一覧 */
  maskedFiles: MaskedFile[];
  maskedCount: number;
  /** <ui_summary> として要約した Designer.vb の件数 */
  uiSummaryCount: number;
  /** extraRoots から含めたファイル数(fileCount にも含まれる) */
  extraRootFileCount: number;
  /** <contract_summary> を生成したか */
  contractSummaryIncluded: boolean;
  /** extraRoots の走査など、出力生成中の診断(呼び出し側が表示する) */
  diagnostics: ParseDiagnostic[];
  /** 出力した <file> の path 属性(出力順。自動テストの有無の判定に使う) */
  filePaths: string[];
}

/**
 * ソースファイルのバイト列を文字列へデコードする。
 * BOM → UTF-16 / UTF-8 を優先し、UTF-8 として不正なら CP932(Shift_JIS)とみなす。
 * Shift_JIS は petari の適用と同じデコーダー(decodeShiftJis)で読む(AI が見る文字と照合する文字を揃える)
 */
export function decodeSourceBuffer(buffer: Buffer): string {
  if (buffer.length >= 2) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    if (b0 === 0xff && b1 === 0xfe) {
      return new TextDecoder("utf-16le").decode(buffer);
    }
    if (b0 === 0xfe && b1 === 0xff) {
      return new TextDecoder("utf-16be").decode(buffer);
    }
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return buffer.subarray(3).toString("utf8");
  }
  // UTF-8 として往復可能なら UTF-8、壊れるなら CP932 とみなす
  const asUtf8 = buffer.toString("utf8");
  if (Buffer.from(asUtf8, "utf8").equals(buffer)) {
    return asUtf8;
  }
  return decodeShiftJis(buffer);
}

/**
 * ツリー1ノードをインデント付きテキストにする(問題のある項目は印を付ける)。
 * annotate は行末の注記(物理パスが論理パスと異なるとき「→ 物理パス」)
 */
function renderTreeLines(
  node: LegacyTreeNode,
  depth: number,
  lines: string[],
  annotate?: (node: FileNode) => string | undefined,
): void {
  const indent = "  ".repeat(depth);
  switch (node.type) {
    case "solution":
    case "project":
    case "folder":
      lines.push(`${indent}${node.label}/`);
      break;
    case "file": {
      const marker = statusMarker(node);
      lines.push(`${indent}${node.label}${marker}${annotate?.(node) ?? ""}`);
      break;
    }
    case "warning":
      lines.push(`${indent}[警告] ${node.message}`);
      break;
  }
  for (const child of node.children) {
    renderTreeLines(child, depth + 1, lines, annotate);
  }
}

function statusMarker(node: FileNode): string {
  switch (node.item.status) {
    case "missing":
      return " [ファイルなし]";
    case "unresolved-expression":
      return " [未解決式]";
    case "wildcard":
      return " [ワイルドカード]";
    case "conditional":
      return " [条件付き]";
    case "resolved":
      return "";
  }
}

/** ツリーを走査して FileNode を表示順で集める(親子入れ子の子も含む) */
function collectFileNodes(node: LegacyTreeNode, into: FileNode[]): void {
  if (node.type === "file") {
    into.push(node);
  }
  for (const child of node.children) {
    collectFileNodes(child, into);
  }
}

/** includeSensitive(boolean / 述語)をファイル単位の判定に解決する */
function includesSensitiveFile(
  include: RepomixExportOptions["includeSensitive"],
  logicalPath: string,
): boolean {
  return typeof include === "function" ? include(logicalPath) : include;
}

/** 含める/除外の判定。除外なら理由を返す */
function skipReason(
  node: FileNode,
  options: RepomixExportOptions,
): string | undefined {
  const item = node.item;
  if (item.kind === "EmbeddedResource") {
    return "EmbeddedResource(リソース)は出力対象外";
  }
  if (item.sourcePath === undefined) {
    return `内容を取得できません(${item.status})`;
  }
  if (!item.exists) {
    return "実ファイルが存在しません";
  }
  if (
    item.isSensitive &&
    !includesSensitiveFile(options.includeSensitive, item.logicalPath)
  ) {
    return "Designer 関連(オプション --include-designer で含められます)";
  }
  const fileName = item.logicalPath.split("\\").pop() ?? "";
  if (isBinaryExtension(fileName)) {
    return "バイナリ拡張子";
  }
  return undefined;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * 除外した *.Designer.vb から <ui_summary> エントリを生成する。
 * 対象外・読めない・コントロールが取れない場合は undefined
 * (呼び出し側は通常のスキップ扱いにする)。
 * maskEnabled 時は要約前の Designer ソースにマスクを適用する
 * (Text 初期値に認証情報が書かれている場合の漏れを防ぐ)。
 */
function buildUiSummaryEntry(
  node: FileNode,
  displayPath: string,
  deps: RepomixExportDeps,
  maskEnabled: boolean,
  strictMask: boolean,
): { entry: string; findings: MaskFinding[] } | undefined {
  const item = node.item;
  if (
    !item.isSensitive ||
    item.sourcePath === undefined ||
    !item.exists ||
    !/\.designer\.vb$/i.test(item.logicalPath)
  ) {
    return undefined;
  }
  if (deps.ignoreReasonFor?.(item.sourcePath) !== undefined) {
    return undefined; // .gitignore 対象は要約もしない
  }
  let source = deps.readTextFile(item.sourcePath);
  if (source === undefined) {
    return undefined;
  }
  let findings: MaskFinding[] = [];
  if (maskEnabled) {
    const masked = maskCredentials(source, {
      vbSource: true,
      strict: strictMask,
    });
    source = masked.content;
    findings = masked.findings;
  }
  const summary = parseDesignerVb(source);
  if (summary.controlCount === 0) {
    return undefined;
  }
  const fileName = item.logicalPath.split("\\").pop() ?? item.logicalPath;
  const formName =
    summary.className ?? fileName.replace(/\.designer\.vb$/i, "");
  const lines = [
    `<ui_summary path="${escapeAttribute(displayPath)}" form="${escapeAttribute(formName)}">`,
    "Designer 自動生成コードからの要約(コントロール名: 型 — Text。座標・サイズ等のレイアウトは省略):",
  ];
  if (summary.formText !== undefined) {
    lines.push(`フォームタイトル: "${summary.formText}"`);
  }
  lines.push(...renderDesignerControlLines(summary.rootControls));
  lines.push("</ui_summary>");
  return { entry: lines.join("\n"), findings };
}

/** 物理パス化の結果(1 ファイル分の表示情報) */
interface PathInfo {
  /** path 属性・スキップ一覧に使う表示パス */
  display: string;
  /** <file> に付ける追加属性(先頭に空白を含む。なければ空) */
  attrs: string;
  /** ルート相対の物理パス(`/` 区切り。ルート内のときのみ) */
  physical?: string | undefined;
  /** ルート外(適用ツールの範囲外) */
  outsideRoot: boolean;
  /** <directory_structure> の行末に併記する注記 */
  treeNote?: string | undefined;
}

/** ドライブ絶対パス(C:\ など)または UNC(\\server\...) */
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

function toPosix(value: string): string {
  return value.split(/[\\/]/).join("/");
}

/** absolutePath が rootDir 配下ならルート相対の `/` 区切りパス、そうでなければ undefined */
export function relativeWithinRoot(
  rootDir: string,
  absolutePath: string,
): string | undefined {
  // Mac 等で Windows のドライブ絶対パス(別ドライブの Link)を扱うときは
  // path.relative が誤って相対扱いするため、先に弾く
  if (WINDOWS_ABSOLUTE.test(absolutePath) !== WINDOWS_ABSOLUTE.test(rootDir)) {
    return undefined;
  }
  const rel = path.relative(rootDir, absolutePath);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith("../") ||
    path.isAbsolute(rel) ||
    WINDOWS_ABSOLUTE.test(rel)
  ) {
    return undefined;
  }
  return toPosix(rel);
}

function describePath(
  source: RepomixSource,
  node: FileNode,
  rootDir: string | undefined,
): PathInfo {
  const item = node.item;
  if (rootDir === undefined) {
    return {
      display: `${source.label}\\${item.logicalPath}`,
      attrs: "",
      outsideRoot: false,
    };
  }
  const logicalPosix = `${source.label}/${toPosix(item.logicalPath)}`;
  if (item.sourcePath === undefined) {
    return { display: logicalPosix, attrs: "", outsideRoot: false };
  }
  const physical = relativeWithinRoot(rootDir, item.sourcePath);
  if (physical === undefined) {
    const physicalPosix = toPosix(item.sourcePath);
    return {
      display: logicalPosix,
      attrs: ` project="${escapeAttribute(source.label)}" physical="${escapeAttribute(physicalPosix)}" outside_root="true"`,
      outsideRoot: true,
      treeNote: ` → ${physicalPosix}(ルート外)`,
    };
  }
  if (physical.toLowerCase() === logicalPosix.toLowerCase()) {
    return { display: physical, attrs: "", physical, outsideRoot: false };
  }
  return {
    display: physical,
    attrs: ` project="${escapeAttribute(source.label)}" logical="${escapeAttribute(item.logicalPath)}"`,
    physical,
    outsideRoot: false,
    treeNote: ` → ${physical}`,
  };
}

/** relativePosix が generatedDirs のいずれかの配下なら、そのディレクトリを返す */
function generatedDirOf(
  relativePosix: string | undefined,
  generatedDirs: readonly string[],
): string | undefined {
  if (relativePosix === undefined) {
    return undefined;
  }
  const lower = relativePosix.toLowerCase();
  return generatedDirs.find((dir) => lower.startsWith(`${dir.toLowerCase()}/`));
}

/** extraRoots のファイルを [kind] path/ 配下のフォルダツリーとして描く */
function renderExtraRootTree(
  root: ExtraRootConfig,
  files: readonly ExtraRootFile[],
  lines: string[],
): void {
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: string[];
  }
  const top: DirNode = { dirs: new Map(), files: [] };
  for (const file of files) {
    const segments = file.relativePath.slice(root.path.length + 1).split("/");
    let cursor = top;
    for (const segment of segments.slice(0, -1)) {
      let next = cursor.dirs.get(segment);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(segments[segments.length - 1] ?? "");
  }
  const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  const render = (node: DirNode, depth: number): void => {
    const indent = "  ".repeat(depth);
    for (const name of [...node.dirs.keys()].sort(byName)) {
      lines.push(`${indent}${name}/`);
      render(node.dirs.get(name) as DirNode, depth + 1);
    }
    for (const name of [...node.files].sort(byName)) {
      lines.push(`${indent}${name}`);
    }
  };
  lines.push(`[${root.kind}] ${root.path}/`);
  render(top, 1);
}

/**
 * Repomix 形式のテキストを生成する。
 * @param title 出力対象の表示名(Sample.sln など)
 */
export function buildRepomixOutput(
  title: string,
  sources: readonly RepomixSource[],
  deps: RepomixExportDeps,
  options: RepomixExportOptions,
): RepomixExportResult {
  const treeLines: string[] = [];
  const fileEntries: string[] = [];
  const skipped: SkippedFile[] = [];
  const maskedFiles: MaskedFile[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const outsideRootPaths: string[] = [];
  const filePaths: string[] = [];
  let fileCount = 0;
  let totalChars = 0;
  let uiSummaryCount = 0;
  let extraRootFileCount = 0;
  // 述語指定時は「含めなかった Designer」が残るので要約は有効のまま
  const uiSummaryEnabled =
    (options.uiSummary ?? true) && options.includeSensitive !== true;
  const strictMask = options.strictMask ?? true;
  const rootDir = options.rootDir;
  const generatedDirs = options.generatedDirs ?? [];
  const includeGenerated = options.includeGenerated ?? false;

  for (const source of sources) {
    const tree = buildLogicalTree(source.parseResult);
    tree.root.label = source.label;
    renderTreeLines(tree.root, 0, treeLines, (node) =>
      describePath(source, node, rootDir).treeNote,
    );

    const fileNodes: FileNode[] = [];
    collectFileNodes(tree.root, fileNodes);
    for (const node of fileNodes) {
      const info = describePath(source, node, rootDir);
      const displayPath = info.display;
      const reason = skipReason(node, options);
      if (reason !== undefined) {
        const uiSummaryEntry = uiSummaryEnabled
          ? buildUiSummaryEntry(
            node,
            displayPath,
            deps,
            options.maskCredentials,
            strictMask,
          )
          : undefined;
        if (uiSummaryEntry !== undefined) {
          fileEntries.push(uiSummaryEntry.entry);
          totalChars += uiSummaryEntry.entry.length;
          uiSummaryCount += 1;
          if (uiSummaryEntry.findings.length > 0) {
            maskedFiles.push({
              path: `${displayPath}(<ui_summary> 生成前の原文)`,
              findings: uiSummaryEntry.findings,
            });
          }
          skipped.push({
            path: displayPath,
            reason: "Designer 関連(<ui_summary> に要約済み)",
          });
        } else {
          skipped.push({ path: displayPath, reason });
        }
        continue;
      }
      if (!includeGenerated) {
        const generatedDir = generatedDirOf(info.physical, generatedDirs);
        if (generatedDir !== undefined) {
          skipped.push({
            path: displayPath,
            reason: `生成コード(${generatedDir}/ 配下。<contract_summary> で代替。オプション --include-generated で含められます)`,
          });
          continue;
        }
      }
      // skipReason 通過時点で sourcePath は解決済み
      const sourcePath = node.item.sourcePath as string;
      const ignoreSource = deps.ignoreReasonFor?.(sourcePath);
      if (ignoreSource !== undefined) {
        skipped.push({
          path: displayPath,
          reason: `.gitignore により除外(${ignoreSource})`,
        });
        continue;
      }
      const rawContent = deps.readTextFile(sourcePath);
      if (rawContent === undefined) {
        skipped.push({ path: displayPath, reason: "読み込みに失敗しました" });
        continue;
      }
      let content = rawContent;
      if (options.maskCredentials) {
        const masked = maskCredentials(rawContent, {
          vbSource: /\.vb$/i.test(displayPath),
          strict: strictMask,
        });
        content = masked.content;
        if (masked.findings.length > 0) {
          maskedFiles.push({ path: displayPath, findings: masked.findings });
        }
      }
      const conditionAttr =
        node.item.condition === undefined
          ? ""
          : ` condition="${escapeAttribute(node.item.condition)}"`;
      if (info.outsideRoot) {
        outsideRootPaths.push(displayPath);
      }
      fileEntries.push(
        `<file path="${escapeAttribute(displayPath)}"${info.attrs}${conditionAttr}>\n${content}\n</file>`,
      );
      filePaths.push(displayPath);
      fileCount += 1;
      totalChars += content.length;
    }
  }

  // ---- 契約サマリー(contract.schema.json → <contract_summary>) ----
  let contractEntry: string | undefined;
  if (options.contractSchema !== undefined && rootDir !== undefined) {
    const schemaPath = options.contractSchema;
    const text = deps.readTextFile(path.resolve(rootDir, ...schemaPath.split("/")));
    if (text === undefined) {
      skipped.push({
        path: schemaPath,
        reason: "契約スキーマを読み込めません(<contract_summary> なし)",
      });
    } else {
      const summary = summarizeContractSchema(text);
      if (!summary.ok) {
        skipped.push({
          path: schemaPath,
          reason: `契約の要約に失敗(${summary.reason})。原文の契約ファイルだけを出力`,
        });
      } else {
        const generatedNote =
          generatedDirs.length > 0 && !includeGenerated
            ? `生成コード ${generatedDirs.map((d) => `${d}/`).join("、")} は除外。`
            : "";
        const contractFile = options.contractFile ?? "契約ファイル(contract.ts)";
        contractEntry = [
          `<contract_summary path="${escapeAttribute(schemaPath)}">`,
          `契約から生成された API の要約(${generatedNote}契約の正本は ${contractFile}):`,
          ...summary.lines,
          "</contract_summary>",
        ].join("\n");
      }
    }
  }

  // ---- extraRoots(.vbproj に乗らない web / 契約ディレクトリ) ----
  const extraRoots = options.extraRoots ?? [];
  let extra: ExtraRootsResult | undefined;
  if (extraRoots.length > 0) {
    if (rootDir === undefined) {
      diagnostics.push({
        severity: "warning",
        message: "extraRoots は物理パス化(rootDir)が有効なときだけ扱えます(--legacy-paths では無視)",
      });
    } else if (deps.listFilesRecursive === undefined) {
      diagnostics.push({
        severity: "warning",
        message: "extraRoots を走査する手段がないため無視しました",
      });
    } else {
      extra = collectExtraRoots(rootDir, extraRoots, {
        listFilesRecursive: deps.listFilesRecursive,
        ignoreReasonFor: deps.ignoreReasonFor,
      });
      diagnostics.push(...extra.diagnostics);
      skipped.push(
        ...extra.skipped.map((s) => ({ path: s.relativePath, reason: s.reason })),
      );
    }
  }
  let contractPlaced = false;
  if (extra !== undefined) {
    for (const root of extraRoots) {
      const files = extra.files.filter((f) => f.rootPath === root.path && f.kind === root.kind);
      renderExtraRootTree(root, files, treeLines);
      for (const file of files) {
        if (
          contractEntry !== undefined &&
          file.relativePath.toLowerCase() === options.contractSchema?.toLowerCase()
        ) {
          skipped.push({
            path: file.relativePath,
            reason: "契約スキーマ(<contract_summary> に要約済み)",
          });
          continue;
        }
        if (!includeGenerated) {
          const generatedDir = generatedDirOf(file.relativePath, generatedDirs);
          if (generatedDir !== undefined) {
            skipped.push({
              path: file.relativePath,
              reason: `生成コード(${generatedDir}/ 配下。<contract_summary> で代替。オプション --include-generated で含められます)`,
            });
            continue;
          }
        }
        const rawContent = deps.readTextFile(file.absolutePath);
        if (rawContent === undefined) {
          skipped.push({ path: file.relativePath, reason: "読み込みに失敗しました" });
          continue;
        }
        let content = rawContent;
        if (options.maskCredentials) {
          const masked = maskCredentials(rawContent, { vbSource: false, strict: strictMask });
          content = masked.content;
          if (masked.findings.length > 0) {
            maskedFiles.push({ path: file.relativePath, findings: masked.findings });
          }
        }
        fileEntries.push(
          `<file path="${escapeAttribute(file.relativePath)}" root="${escapeAttribute(file.kind)}">\n${content}\n</file>`,
        );
        filePaths.push(file.relativePath);
        fileCount += 1;
        extraRootFileCount += 1;
        totalChars += content.length;
      }
      // 契約ファイルの直後に要約を置く(ui_summary と同じ発想)
      if (root.kind === "contract" && contractEntry !== undefined && !contractPlaced) {
        fileEntries.push(contractEntry);
        totalChars += contractEntry.length;
        contractPlaced = true;
      }
    }
  }
  if (contractEntry !== undefined && !contractPlaced) {
    fileEntries.push(contractEntry);
    totalChars += contractEntry.length;
    contractPlaced = true;
  }

  const maskedCount = maskedFiles.reduce(
    (sum, file) => sum + file.findings.length,
    0,
  );

  const skippedSection =
    skipped.length === 0
      ? "(なし)"
      : skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n");

  const maskedSection = !options.maskCredentials
    ? "(マスク機能は設定で無効化されています)"
    : maskedFiles.length === 0
      ? "(検出なし)"
      : maskedFiles
          .map(
            (file) =>
              `- ${file.path}: ${file.findings
                .map((f) => `L${f.line}(${f.kind})`)
                .join(", ")}`,
          )
          .join("\n");

  const sdkExpandedLabels = sources
    .filter((source) => source.parseResult.defaultCompileGlobExpanded)
    .map((source) => source.label);
  const rootName = rootDir === undefined ? undefined : path.basename(rootDir);

  const generic = options.layout === "generic";
  const configFileName = options.configFileName ?? CONFIG_FILE_NAME;

  const content = [
    generic
      ? `このファイルは ${TOOL_NAME} が「${title}」の ${configFileName}(extraRoots)に宣言されたディレクトリに基づき、ソースコードを 1 ファイルにまとめたものです(Repomix 形式)。`
      : `このファイルは ${TOOL_NAME} が「${title}」の論理構成(.sln / .vbproj)に基づき、ソースコードを 1 ファイルにまとめたものです(Repomix 形式)。`,
    "",
    "<file_summary>",
    "<purpose>",
    "AI にコードベース全体を渡すためのパック済み表現。",
    generic
      ? "<directory_structure> と <file> の path 属性は、ルートからの相対物理パスに基づく(.sln / .vbproj の論理構成は使っていない)。"
      : rootDir === undefined
        ? "パスは物理配置ではなく Visual Studio の論理構成(Link 解決済み)に基づく。"
        : "<directory_structure> は Visual Studio の論理構成(Link 解決済み)、<file> の path 属性は物理配置に基づく。",
    "AI がコードを理解し質問に回答するための入力であり、このままコンパイル・実行できる形であることは保証しない。",
    "</purpose>",
    "<notes>",
    ...(rootDir === undefined
      ? []
      : generic
        ? [
            `- <file> の path 属性はルート「${rootName}」からの相対物理パス(/ 区切り)。changes.md のパスはこの path をそのまま使うこと。新規ファイルも同じ規則で書くこと`,
          ]
        : [
          `- <file> の path 属性はルート「${rootName}」からの相対物理パス(/ 区切り)。changes.md のパスはこの path をそのまま使うこと。新規ファイルも同じ規則で、置きたいプロジェクトの物理フォルダ配下に書くこと`,
          "- 論理パス(Visual Studio 上の見え方)と物理パスが異なるファイル(Link)は logical / project 属性を持ち、<directory_structure> では「→ 物理パス」を併記",
          ...(outsideRootPaths.length > 0
            ? [
                `- ルート外のファイル(適用ツールの範囲外。物理パスは physical 属性): ${outsideRootPaths.join(", ")}`,
              ]
            : []),
        ]),
    "- 文字コードは UTF-8 に統一済み(元ファイルの Shift_JIS 等は自動変換)",
    ...(generic
      ? []
      : [
          "- EmbeddedResource(.resx)は含まれない",
          options.includeSensitive === true
            ? "- Designer 関連ファイルは含まれる"
            : typeof options.includeSensitive === "function"
              ? uiSummaryEnabled
                ? "- Designer 関連ファイルは指定されたもののみ原文を含む(それ以外はフォームのコントロール構成のみ <ui_summary> として要約)"
                : "- Designer 関連ファイルは指定されたもののみ含まれる"
              : uiSummaryEnabled
                ? "- Designer 関連ファイルの原文は含まれない(フォームのコントロール構成のみ <ui_summary> として要約)"
                : "- Designer 関連ファイルは含まれない",
        ]),
    options.maskCredentials
      ? "- 認証情報らしき値は [MASKED] に自動置換済み。[MASKED] は伏せ字であり、元のソースには実際の値が存在する(<masked_credentials> を参照。機械判定のため漏れの可能性はあり、共有前に目視確認を推奨)"
      : "- 認証情報の自動マスクは無効(ハードコードされた認証情報がそのまま含まれる可能性あり)",
    ...(options.maskCredentials && strictMask
      ? [
          "- 厳格モード: ランダムな英数字列(高エントロピー値)も機械的にマスクしている。秘密でない値が [MASKED] になっている可能性もあるが、コードの構造・ロジックの理解には影響しない",
        ]
      : []),
    ...(options.maskCredentials
      ? [
          "- AI への指示: [MASKED] の実際の値を尋ねられた場合は、マスクされているため回答できない旨を伝えること。[MASKED] を実際の値・バグ・空文字と解釈しないこと",
        ]
      : []),
    deps.ignoreReasonFor !== undefined
      ? "- .gitignore / .repomixignore に一致するファイルは除外済み(本家 repomix と同様)"
      : "- .gitignore は考慮していない(設定 exportRespectGitignore で無効化されている)",
    ...(sdkExpandedLabels.length > 0
      ? [
          `- SDK スタイルのプロジェクト(${sdkExpandedLabels.join(", ")})は Compile を明示列挙しないため、既定の Compile グロブ(**/*.vb)を展開した(bin/ obj/ ドットフォルダ・*.user・<Compile Remove> は除外)。MSBuild の完全評価ではない`,
        ]
      : []),
    ...(extra !== undefined
      ? [
          generic
            ? `- [${extraRoots.map((r) => r.kind).join("] [")}] のグループは ${configFileName} の extraRoots に宣言されたディレクトリ(<file> の root 属性)。宣言されていないディレクトリは含まれない`
            : `- [${extraRoots.map((r) => r.kind).join("] [")}] のグループは .vbproj に乗らない追加ディレクトリ(${configFileName} の extraRoots。<file> の root 属性)。認証情報マスクは VB 側と同様に適用済み`,
        ]
      : []),
    ...(generatedDirs.length > 0
      ? [
          includeGenerated
            ? `- 生成コード(${generatedDirs.map((d) => `${d}/`).join("、")})の原文を含む(オプション --include-generated)。生成物は変更対象にせず、契約の変更として提案すること`
            : `- 生成コード(${generatedDirs.map((d) => `${d}/`).join("、")})は除外し、契約の要約 <contract_summary> で代替。生成物は変更対象にせず、契約の変更として提案すること`,
        ]
      : []),
    "- 除外・未解決のファイルは <skipped_files> を参照",
    "- このファイルは読み取り専用の成果物であり、編集しても元のプロジェクトには反映されない",
    "</notes>",
    "</file_summary>",
    "",
    "<directory_structure>",
    treeLines.join("\n"),
    "</directory_structure>",
    "",
    "<files>",
    fileEntries.join("\n\n"),
    "</files>",
    "",
    "<skipped_files>",
    skippedSection,
    "</skipped_files>",
    "",
    "<masked_credentials>",
    maskedSection,
    "</masked_credentials>",
    "",
  ].join("\n");

  return {
    content,
    fileCount,
    totalChars,
    skipped,
    maskedFiles,
    maskedCount,
    uiSummaryCount,
    extraRootFileCount,
    contractSummaryIncluded: contractPlaced,
    diagnostics,
    filePaths,
  };
}
