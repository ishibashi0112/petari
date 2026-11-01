/**
 * logicalTreeBuilder の単体テスト。
 * fixture 経由(parseVbproj → buildLogicalTree)の統合ケースと、
 * ProjectItem を直接組み立てる合成ケース(親不在・循環など)の両方で検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildLogicalTree, buildSolutionTree } from "../../src/pack/logicalTreeBuilder.ts";
import { parseSln } from "../../src/pack/slnParser.ts";
import type {
  LegacyTreeNode,
  ProjectItem,
  VbprojParseResult,
} from "../../src/pack/types.ts";
import { parseVbproj } from "../../src/pack/vbprojParser.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

function parseFixture(
  relativeVbprojPath: string,
  deps: { fileExists(p: string): boolean } = { fileExists: (p) => fs.existsSync(p) },
): VbprojParseResult {
  const projectPath = path.join(FIXTURES_ROOT, relativeVbprojPath);
  return parseVbproj(fs.readFileSync(projectPath, "utf8"), projectPath, deps);
}

/** 合成テスト用の ProjectItem を最小の記述で作る */
function makeItem(
  overrides: Partial<ProjectItem> & { include: string },
): ProjectItem {
  return {
    kind: "Compile",
    logicalPath: overrides.include,
    exists: true,
    status: "resolved",
    isSensitive: false,
    metadata: {},
    ...overrides,
  };
}

function makeResult(items: ProjectItem[]): VbprojParseResult {
  return {
    projectPath: "/tmp/proj/Test.vbproj",
    projectDir: "/tmp/proj",
    projectStyle: "legacy",
    defaultCompileGlobExpanded: false,
    items,
    diagnostics: [],
  };
}

/** ラベルで子ノードを特定する(見つからなければ fail) */
function child(node: LegacyTreeNode, label: string): LegacyTreeNode {
  const found = node.children.find((candidate) => candidate.label === label);
  assert.ok(
    found !== undefined,
    `"${label}" が "${node.label}" の配下に見つかりません(実際: ${node.children
      .map((c) => c.label)
      .join(", ")})`,
  );
  return found;
}

suite("logicalTreeBuilder: basic fixture", () => {
  const tree = buildLogicalTree(parseFixture("basic/Basic.vbproj"));

  test("ルートはプロジェクト名で、フォルダ→ファイルの順に並ぶ", () => {
    assert.strictEqual(tree.root.type, "project");
    assert.strictEqual(tree.root.label, "Basic");
    assert.deepStrictEqual(
      tree.root.children.map((node) => node.label),
      ["Forms", "My Project", "App.config", "Module1.vb"],
    );
  });

  test("DependentUpon で Designer / resx がフォーム配下に入る", () => {
    const forms = child(tree.root, "Forms");
    assert.strictEqual(forms.type, "folder");
    // Designer と resx は OrderForm.vb の子になり、フォルダ直下には残らない
    assert.deepStrictEqual(
      forms.children.map((node) => node.label),
      ["OrderForm.vb"],
    );
    const orderForm = child(forms, "OrderForm.vb");
    assert.deepStrictEqual(
      orderForm.children.map((node) => node.label),
      ["OrderForm.Designer.vb", "OrderForm.resx"],
    );
  });

  test("My Project 配下は .myapp を親として Designer.vb が入れ子になる", () => {
    const myProject = child(tree.root, "My Project");
    const myapp = child(myProject, "Application.myapp");
    assert.deepStrictEqual(
      myapp.children.map((node) => node.label),
      ["Application.Designer.vb"],
    );
  });

  test("ツリー構築の診断は発生しない", () => {
    assert.deepStrictEqual(tree.diagnostics, []);
  });
});

suite("logicalTreeBuilder: linked-file fixture", () => {
  const tree = buildLogicalTree(parseFixture("linked-file/App/Linked.vbproj"));

  test("Link 先の論理フォルダに表示され、物理フォルダ名は現れない", () => {
    const common = child(tree.root, "Common");
    assert.strictEqual(common.type, "folder");
    assert.deepStrictEqual(
      common.children.map((node) => node.label),
      ["DateHelper.vb"],
    );
    // 物理配置の Shared フォルダはツリーに存在しない
    assert.ok(tree.root.children.every((node) => node.label !== "Shared"));
  });
});

suite("logicalTreeBuilder: edge-cases fixture", () => {
  const tree = buildLogicalTree(
    parseFixture("edge-cases/EdgeCases.vbproj", { fileExists: () => false }),
  );

  test("式付きでも Link があれば論理フォルダに配置される", () => {
    const common = child(tree.root, "Common");
    const helper = child(common, "Helper.vb");
    assert.strictEqual(helper.type, "file");
    assert.ok(helper.type === "file" && helper.item.status === "unresolved-expression");
  });

  test("ワイルドカード項目はフォルダ分割せずルート直下に全体を表示する", () => {
    const wildcard = child(tree.root, "Common\\**\\*.vb");
    assert.strictEqual(wildcard.type, "file");
    // "**" や "*.vb" という名前のフォルダを作らない
    const common = child(tree.root, "Common");
    assert.ok(common.children.every((node) => node.label !== "**"));
  });
});

suite("logicalTreeBuilder: 合成ケース", () => {
  test("DependentUpon の親が見つからない場合、子はフォルダ直下に残り警告になる", () => {
    const tree = buildLogicalTree(
      makeResult([
        makeItem({
          include: "Forms\\Orphan.Designer.vb",
          dependentUpon: "Nope.vb",
        }),
      ]),
    );
    const forms = child(tree.root, "Forms");
    assert.deepStrictEqual(
      forms.children.map((node) => node.label),
      ["Orphan.Designer.vb"],
    );
    assert.ok(
      tree.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes('"Nope.vb"'),
      ),
    );
  });

  test("親の探索は大文字小文字を区別しない", () => {
    const tree = buildLogicalTree(
      makeResult([
        makeItem({ include: "FORMS\\OrderForm.vb" }),
        makeItem({
          include: "Forms\\orderform.designer.vb",
          dependentUpon: "ORDERFORM.VB",
        }),
      ]),
    );
    // フォルダは先に出現した表記(FORMS)で 1 つに統合される
    const forms = child(tree.root, "FORMS");
    const parent = child(forms, "OrderForm.vb");
    assert.deepStrictEqual(
      parent.children.map((node) => node.label),
      ["orderform.designer.vb"],
    );
    assert.deepStrictEqual(tree.diagnostics, []);
  });

  test("DependentUpon の循環は解除して警告を出す(無限ループしない)", () => {
    const tree = buildLogicalTree(
      makeResult([
        makeItem({ include: "A.vb", dependentUpon: "B.vb" }),
        makeItem({ include: "B.vb", dependentUpon: "A.vb" }),
      ]),
    );
    assert.ok(
      tree.diagnostics.some((d) => d.message.includes("循環")),
    );
    // 両ノードともツリーのどこかに存在する(消えない)
    const labels: string[] = [];
    const collect = (node: LegacyTreeNode): void => {
      labels.push(node.label);
      node.children.forEach(collect);
    };
    collect(tree.root);
    assert.ok(labels.includes("A.vb"));
    assert.ok(labels.includes("B.vb"));
  });

  test("解析エラーはルート直下の警告ノードになる", () => {
    const result = parseFixture("malformed/Broken.vbproj");
    const tree = buildLogicalTree(result);
    assert.ok(tree.root.children.some((node) => node.type === "warning"));
  });
});

suite("logicalTreeBuilder: buildSolutionTree", () => {
  const solutionPath = path.join(FIXTURES_ROOT, "solution", "Sample.sln");
  const slnResult = parseSln(fs.readFileSync(solutionPath, "utf8"), solutionPath, {
    fileExists: (p) => fs.existsSync(p),
  });
  const projectResults = slnResult.projects
    .filter((project) => project.exists)
    .map((project) =>
      parseVbproj(
        fs.readFileSync(project.absolutePath, "utf8"),
        project.absolutePath,
        { fileExists: (p) => fs.existsSync(p) },
      ),
    );
  const tree = buildSolutionTree(slnResult, projectResults);

  test("ルートはソリューション名で、.sln の定義順にプロジェクトが並ぶ", () => {
    assert.strictEqual(tree.root.type, "solution");
    assert.strictEqual(tree.root.label, "Sample");
    assert.deepStrictEqual(
      tree.root.children.map((node) => node.type),
      ["project", "project", "warning"],
    );
  });

  test("プロジェクト名は .sln 上の名前を使う", () => {
    assert.deepStrictEqual(
      tree.root.children
        .filter((node) => node.type === "project")
        .map((node) => node.label),
      ["Basic", "LinkedApp"],
    );
  });

  test("欠落プロジェクトは警告ノードと診断になる", () => {
    const warning = tree.root.children.find((node) => node.type === "warning");
    assert.ok(warning !== undefined);
    assert.ok(warning.label.includes("Gone"));
    assert.ok(
      tree.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("Gone"),
      ),
    );
  });

  test("各プロジェクトのサブツリーが構築される", () => {
    const basic = child(tree.root, "Basic");
    const forms = child(basic, "Forms");
    assert.deepStrictEqual(
      forms.children.map((node) => node.label),
      ["OrderForm.vb"],
    );
  });

  test("ソリューション全体でノード ID が一意になる", () => {
    const ids = new Set<string>();
    const collect = (node: LegacyTreeNode): void => {
      assert.ok(!ids.has(node.id), `ID が重複: ${node.id}`);
      ids.add(node.id);
      node.children.forEach(collect);
    };
    collect(tree.root);
  });

  test("複数プロジェクト間でもノード ID は一意になる(名前空間化)", () => {
    // 別プロジェクトに同名の論理フォルダ・ファイルがあるケース
    const resultA = makeResult([makeItem({ include: "Forms\\Shared.vb" })]);
    const resultB: VbprojParseResult = {
      ...makeResult([makeItem({ include: "Forms\\Shared.vb" })]),
      projectPath: "/tmp/proj2/Other.vbproj",
      projectDir: "/tmp/proj2",
      projectStyle: "legacy",
      defaultCompileGlobExpanded: false,
    };
    const ids = new Set<string>();
    const collect = (node: LegacyTreeNode): void => {
      assert.ok(!ids.has(node.id), `ID が重複: ${node.id}`);
      ids.add(node.id);
      node.children.forEach(collect);
    };
    collect(buildLogicalTree(resultA).root);
    collect(buildLogicalTree(resultB).root);
  });

  test("同じ論理パスが重複してもノード ID は一意になる", () => {
    const tree = buildLogicalTree(
      makeResult([
        makeItem({ include: "Dup.vb" }),
        makeItem({ include: "Dup.vb" }),
      ]),
    );
    const ids = new Set<string>();
    const collect = (node: LegacyTreeNode): void => {
      assert.ok(!ids.has(node.id), `ID が重複: ${node.id}`);
      ids.add(node.id);
      node.children.forEach(collect);
    };
    collect(tree.root);
    assert.strictEqual(tree.root.children.length, 2);
  });
});
