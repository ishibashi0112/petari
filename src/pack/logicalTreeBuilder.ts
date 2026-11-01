/**
 * 正規化済み ProjectItem 配列から論理ツリーを構築する。
 *
 * - 物理パスではなく logicalPath(Link 優先)を基準にする
 * - DependentUpon の親は「同じ論理フォルダ内」から大文字小文字を区別せず探す
 * - 親が見つからない・循環している場合も子項目は削除せずツリーに残す
 * - vscode モジュールには依存しない純粋関数(単体テスト対象)
 */

import type {
  FileNode,
  FolderNode,
  LegacyTreeNode,
  ParseDiagnostic,
  ProjectItem,
  ProjectNode,
  SlnParseResult,
  SolutionNode,
  VbprojParseResult,
} from "./types.ts";

export interface LogicalTreeResult {
  root: ProjectNode;
  /** ツリー構築中に検出した問題(DependentUpon の親不在など) */
  diagnostics: ParseDiagnostic[];
}

export interface SolutionTreeResult {
  root: SolutionNode;
  diagnostics: ParseDiagnostic[];
}

/** フォルダ分割できない論理パス(MSBuild 式・ワイルドカードを含む) */
const UNSPLITTABLE = /[$@%]\(|[*?]/;

/** 内部作業用: ProjectItem と生成した FileNode の対 */
interface WorkEntry {
  item: ProjectItem;
  node: FileNode;
  /** 論理フォルダのセグメント(分割不能な場合は空 = プロジェクト直下) */
  dirSegments: string[];
  splittable: boolean;
  parent?: WorkEntry | undefined;
}

function projectLabelOf(projectPath: string): string {
  const fileName = projectPath.split(/[\\/]/).pop() ?? projectPath;
  return fileName.replace(/\.vbproj$/i, "");
}

function compareNodes(a: LegacyTreeNode, b: LegacyTreeNode): number {
  // 警告 → フォルダ → ファイルの順。同種はラベルの大文字小文字を無視した昇順
  const rank = (node: LegacyTreeNode): number => {
    if (node.type === "warning") {
      return 0;
    }
    return node.type === "folder" ? 1 : 2;
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const left = a.label.toLowerCase();
  const right = b.label.toLowerCase();
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function sortRecursively(node: LegacyTreeNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) {
    sortRecursively(child);
  }
}

export function buildLogicalTree(parseResult: VbprojParseResult): LogicalTreeResult {
  const diagnostics: ParseDiagnostic[] = [];
  // 複数プロジェクトを同一ツリーに表示しても TreeItem.id が衝突しないよう、
  // プロジェクトパスで ID を名前空間化する
  const idPrefix = parseResult.projectPath.toLowerCase();
  const root: ProjectNode = {
    type: "project",
    id: `project:${idPrefix}`,
    label: projectLabelOf(parseResult.projectPath),
    projectPath: parseResult.projectPath,
    children: [],
  };

  // 解析段階の error はツリー上でも警告ノードとして見えるようにする
  parseResult.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .forEach((diagnostic, index) => {
      root.children.push({
        type: "warning",
        id: `warning:${idPrefix}:${index}`,
        label: diagnostic.message,
        message: diagnostic.message,
        children: [],
      });
    });

  // 1. 全項目の FileNode を作る
  const entries: WorkEntry[] = parseResult.items.map((item, index) => {
    const splittable = !UNSPLITTABLE.test(item.logicalPath);
    const segments = item.logicalPath.split("\\").filter((s) => s !== "");
    // 式・ワイルドカードを含む場合はフォルダを作らず論理パス全体をラベルにする
    const label = splittable
      ? (segments[segments.length - 1] ?? item.include)
      : item.logicalPath;
    return {
      item,
      splittable,
      dirSegments: splittable ? segments.slice(0, -1) : [],
      node: {
        type: "file",
        id: `file:${idPrefix}:${index}:${item.logicalPath.toLowerCase()}`,
        label,
        item,
        children: [],
      },
    };
  });

  // 2. DependentUpon の親を「同じ論理フォルダ内」から大文字小文字無視で探す
  const byLogicalPathLower = new Map<string, WorkEntry>();
  for (const entry of entries) {
    const key = entry.item.logicalPath.toLowerCase();
    if (!byLogicalPathLower.has(key)) {
      byLogicalPathLower.set(key, entry);
    }
  }
  for (const entry of entries) {
    const dependentUpon = entry.item.dependentUpon;
    if (dependentUpon === undefined || !entry.splittable) {
      continue;
    }
    const parentKey = [...entry.dirSegments, dependentUpon].join("\\").toLowerCase();
    const parent = byLogicalPathLower.get(parentKey);
    if (parent === undefined || parent === entry) {
      diagnostics.push({
        severity: "warning",
        message: `DependentUpon の親 "${dependentUpon}" が同じ論理フォルダ内に見つかりません(子はフォルダ直下に表示します)`,
        itemInclude: entry.item.include,
      });
      continue;
    }
    entry.parent = parent;
  }

  // 3. 循環参照があれば解除する(親をたどって自分に戻るケース)
  for (const entry of entries) {
    const seen = new Set<WorkEntry>([entry]);
    let cursor = entry.parent;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        diagnostics.push({
          severity: "warning",
          message: "DependentUpon が循環しているため親子化を解除しました",
          itemInclude: entry.item.include,
        });
        entry.parent = undefined;
        break;
      }
      seen.add(cursor);
      cursor = cursor.parent;
    }
  }

  // 4. 親持ちは親の FileNode 配下へ、それ以外は論理フォルダ配下へ
  const folderMap = new Map<string, FolderNode>();
  const ensureFolder = (segments: string[]): ProjectNode | FolderNode => {
    if (segments.length === 0) {
      return root;
    }
    const key = segments.join("\\").toLowerCase();
    const existing = folderMap.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const parent = ensureFolder(segments.slice(0, -1));
    const folder: FolderNode = {
      type: "folder",
      id: `folder:${idPrefix}:${key}`,
      // 最初に出現した表記の大文字小文字をラベルとして採用する
      label: segments[segments.length - 1] ?? "",
      logicalPath: segments.join("\\"),
      children: [],
    };
    folderMap.set(key, folder);
    parent.children.push(folder);
    return folder;
  };

  for (const entry of entries) {
    if (entry.parent !== undefined) {
      entry.parent.node.children.push(entry.node);
    } else {
      ensureFolder(entry.dirSegments).children.push(entry.node);
    }
  }

  sortRecursively(root);
  return { root, diagnostics };
}

/**
 * .sln の解析結果と各 .vbproj の解析結果からソリューションツリーを構築する。
 * projectResults に対応する結果がないプロジェクト(ファイル欠落・読み込み失敗)は
 * 警告ノードとしてツリーに残す。プロジェクトの並びは .sln の定義順を維持する。
 */
export function buildSolutionTree(
  slnResult: SlnParseResult,
  projectResults: readonly VbprojParseResult[],
): SolutionTreeResult {
  const diagnostics: ParseDiagnostic[] = [];
  const idPrefix = slnResult.solutionPath.toLowerCase();
  const solutionFileName =
    slnResult.solutionPath.split(/[\\/]/).pop() ?? slnResult.solutionPath;
  const root: SolutionNode = {
    type: "solution",
    id: `solution:${idPrefix}`,
    label: solutionFileName.replace(/\.sln$/i, ""),
    solutionPath: slnResult.solutionPath,
    children: [],
  };

  slnResult.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .forEach((diagnostic, index) => {
      root.children.push({
        type: "warning",
        id: `warning:${idPrefix}:${index}`,
        label: diagnostic.message,
        message: diagnostic.message,
        children: [],
      });
    });

  const resultByPathLower = new Map<string, VbprojParseResult>(
    projectResults.map((result) => [result.projectPath.toLowerCase(), result]),
  );

  for (const project of slnResult.projects) {
    const parsed = resultByPathLower.get(project.absolutePath.toLowerCase());
    if (parsed === undefined) {
      const message = project.exists
        ? `プロジェクトを読み込めませんでした: ${project.name}(${project.absolutePath})`
        : `プロジェクトファイルが見つかりません: ${project.name}(${project.absolutePath})`;
      diagnostics.push({ severity: "warning", message });
      root.children.push({
        type: "warning",
        id: `warning:${idPrefix}:missing:${project.absolutePath.toLowerCase()}`,
        label: message,
        message,
        children: [],
      });
      continue;
    }
    const tree = buildLogicalTree(parsed);
    // 表示名は .sln 上のプロジェクト名を優先する
    tree.root.label = project.name;
    diagnostics.push(...tree.diagnostics);
    root.children.push(tree.root);
  }

  return { root, diagnostics };
}
