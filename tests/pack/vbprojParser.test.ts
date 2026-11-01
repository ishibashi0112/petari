/**
 * vbprojParser の単体テスト。
 * パーサーは純粋関数のため vscode モジュールには依存しない。
 * ファイル存在確認は基本的に fake を注入し、実ファイルを使う fixture
 * (basic / linked-file)のみ実 fs で検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectItem, VbprojParseResult } from "../../src/pack/types.ts";
import { parseVbproj, type VbprojParserDeps } from "../../src/pack/vbprojParser.ts";

/** tests/fixtures/pack(slnmix から移したフィクスチャ)を参照する */
const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

const realFs: VbprojParserDeps = {
  fileExists: (p: string): boolean => fs.existsSync(p),
  listFilesRecursive,
};

function parseFixture(
  relativeVbprojPath: string,
  deps: VbprojParserDeps = realFs,
): VbprojParseResult {
  const projectPath = path.join(FIXTURES_ROOT, relativeVbprojPath);
  const xml = fs.readFileSync(projectPath, "utf8");
  return parseVbproj(xml, projectPath, deps);
}

/** Include 値で項目を特定する(見つからなければ fail) */
function findItem(result: VbprojParseResult, include: string): ProjectItem {
  const item = result.items.find((candidate) => candidate.include === include);
  assert.ok(item !== undefined, `Include="${include}" の項目が見つかりません`);
  return item;
}

suite("vbprojParser: basic fixture", () => {
  const result = parseFixture("basic/Basic.vbproj");

  test("ファイル項目を全件抽出する(Reference は対象外)", () => {
    assert.strictEqual(result.items.length, 7);
    assert.ok(result.items.every((item) => item.kind !== "Reference"));
  });

  test("実在するファイルは resolved / exists=true になる", () => {
    for (const item of result.items) {
      assert.strictEqual(item.status, "resolved", item.include);
      assert.strictEqual(item.exists, true, item.include);
      assert.ok(item.sourcePath !== undefined && path.isAbsolute(item.sourcePath));
    }
  });

  test("SubType / DependentUpon を抽出する", () => {
    assert.strictEqual(findItem(result, "Forms\\OrderForm.vb").subType, "Form");
    assert.strictEqual(
      findItem(result, "Forms\\OrderForm.Designer.vb").dependentUpon,
      "OrderForm.vb",
    );
    assert.strictEqual(
      findItem(result, "Forms\\OrderForm.resx").dependentUpon,
      "OrderForm.vb",
    );
  });

  test("Designer 関連の判定(拡張子・AutoGen・Generator)", () => {
    assert.strictEqual(findItem(result, "Forms\\OrderForm.Designer.vb").isSensitive, true);
    assert.strictEqual(findItem(result, "Forms\\OrderForm.resx").isSensitive, true);
    assert.strictEqual(
      findItem(result, "My Project\\Application.Designer.vb").isSensitive,
      true,
    );
    // Generator / LastGenOutput を持つ .myapp も対象
    assert.strictEqual(
      findItem(result, "My Project\\Application.myapp").isSensitive,
      true,
    );
    assert.strictEqual(findItem(result, "Module1.vb").isSensitive, false);
    assert.strictEqual(findItem(result, "Forms\\OrderForm.vb").isSensitive, false);
  });

  test("メタデータを未知のものも含めて保持する", () => {
    const myapp = findItem(result, "My Project\\Application.myapp");
    assert.strictEqual(myapp.metadata["Generator"], "MyApplicationCodeGenerator");
    assert.strictEqual(myapp.metadata["LastGenOutput"], "Application.Designer.vb");
  });

  test("Reference は未対応種別として診断に記録される", () => {
    const diagnostic = result.diagnostics.find((d) =>
      d.message.includes("Reference ×2"),
    );
    assert.ok(diagnostic !== undefined, "Reference の診断がありません");
    assert.strictEqual(diagnostic.severity, "info");
  });
});

suite("vbprojParser: linked-file fixture", () => {
  const result = parseFixture("linked-file/App/Linked.vbproj");

  test("Link が論理パスに使われる", () => {
    const item = findItem(result, "..\\Shared\\DateHelper.vb");
    assert.strictEqual(item.link, "Common\\DateHelper.vb");
    assert.strictEqual(item.logicalPath, "Common\\DateHelper.vb");
  });

  test("外部相対パスが .vbproj 基準で解決され実在する", () => {
    const item = findItem(result, "..\\Shared\\DateHelper.vb");
    const expected = path.join(FIXTURES_ROOT, "linked-file", "Shared", "DateHelper.vb");
    assert.strictEqual(item.sourcePath, expected);
    assert.strictEqual(item.status, "resolved");
    assert.strictEqual(item.exists, true);
  });
});

suite("vbprojParser: edge-cases fixture", () => {
  // D:\Shared\External.vb だけが「存在する」fake ファイルシステム
  const fakeFs = {
    fileExists: (p: string): boolean => p === "D:\\Shared\\External.vb",
  };
  const result = parseFixture("edge-cases/EdgeCases.vbproj", fakeFs);

  test("MSBuild 式は unresolved-expression(Link は論理パスに反映)", () => {
    const item = findItem(result, "$(SharedSourceRoot)\\Common\\Helper.vb");
    assert.strictEqual(item.status, "unresolved-expression");
    assert.strictEqual(item.sourcePath, undefined);
    assert.strictEqual(item.logicalPath, "Common\\Helper.vb");
    assert.ok(item.unresolvedReason !== undefined);
  });

  test("ワイルドカードは wildcard として展開しない", () => {
    const item = findItem(result, "Common\\**\\*.vb");
    assert.strictEqual(item.status, "wildcard");
    assert.strictEqual(item.sourcePath, undefined);
  });

  test("存在しないファイルは missing / exists=false", () => {
    const item = findItem(result, "Missing.vb");
    assert.strictEqual(item.status, "missing");
    assert.strictEqual(item.exists, false);
  });

  test("ドライブ絶対パスは Windows パスとして正規化する", () => {
    const item = findItem(result, "D:\\Shared\\External.vb");
    assert.strictEqual(item.sourcePath, "D:\\Shared\\External.vb");
    assert.strictEqual(item.status, "resolved");
    assert.strictEqual(item.exists, true);
  });

  test("ItemGroup の Condition は配下の項目へ継承される", () => {
    const item = findItem(result, "DebugOnly.vb");
    assert.strictEqual(item.status, "conditional");
    assert.strictEqual(item.condition, "'$(Configuration)' == 'Debug'");
    // Condition 付きでもパス解決と存在確認は行う
    assert.ok(item.sourcePath !== undefined);
    assert.strictEqual(item.exists, false);
  });

  test("Item 単体の Condition も conditional になる", () => {
    const item = findItem(result, "ItemCond.vb");
    assert.strictEqual(item.status, "conditional");
    assert.strictEqual(item.condition, "'$(BuildFlavor)' == 'Special'");
  });

  test("Include のない項目はスキップし警告を残す", () => {
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("Include 属性のない"),
      ),
    );
  });

  test("Import / Choose / 参照系は診断として報告される", () => {
    assert.ok(result.diagnostics.some((d) => d.message.includes("<Import>")));
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("<Choose>"),
      ),
    );
    const unsupported = result.diagnostics.find((d) =>
      d.message.includes("未対応の項目種別"),
    );
    assert.ok(unsupported !== undefined);
    assert.ok(unsupported.message.includes("ProjectReference ×1"));
    assert.ok(unsupported.message.includes("Reference ×1"));
    assert.ok(unsupported.message.includes("COMReference ×1"));
  });

  test("Choose 内の項目は抽出されない(評価しないため)", () => {
    assert.ok(result.items.every((item) => item.include !== "ChooseOnly.vb"));
    assert.ok(result.items.every((item) => item.include !== "ChooseOtherwise.vb"));
  });
});

suite("vbprojParser: 入力の頑健性", () => {
  test("BOM 付き XML を解析できる", () => {
    const xml =
      "\uFEFF" +
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">' +
      '<ItemGroup><Compile Include="A.vb" /></ItemGroup>' +
      "</Project>";
    const result = parseVbproj(xml, "/tmp/Bom.vbproj", { fileExists: () => true });
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0]?.status, "resolved");
  });

  test("単一 ItemGroup・単一 Compile でも配列として扱う", () => {
    const xml =
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">' +
      '<ItemGroup><Compile Include="Only.vb" /></ItemGroup>' +
      "</Project>";
    const result = parseVbproj(xml, "/tmp/Single.vbproj", { fileExists: () => true });
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0]?.include, "Only.vb");
  });

  test("壊れた XML は error 診断を返し、項目は空になる", () => {
    const result = parseFixture("malformed/Broken.vbproj");
    assert.strictEqual(result.items.length, 0);
    assert.ok(result.diagnostics.some((d) => d.severity === "error"));
  });

  test("Project 要素がない XML は error 診断を返す", () => {
    const result = parseVbproj("<Foo />", "/tmp/NotProj.vbproj", realFs);
    assert.strictEqual(result.items.length, 0);
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "error" && d.message.includes("<Project>"),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// SDK スタイル(フェーズ 2)
// ---------------------------------------------------------------------------

/** グロブ展開の対象ファイルを fake で与える(パスは projectDir 基準の相対) */
function fakeSdkDeps(
  projectDir: string,
  relativeFiles: string[],
): VbprojParserDeps {
  const absolute = relativeFiles.map((rel) => path.join(projectDir, ...rel.split("/")));
  return {
    fileExists: (p) => absolute.some((a) => a.toLowerCase() === p.toLowerCase()),
    listFilesRecursive: (dir) =>
      dir === projectDir ? absolute : undefined,
  };
}

const SDK_PROJECT_PATH = path.join(FIXTURES_ROOT, "virtual", "Sdk.vbproj");
const SDK_PROJECT_DIR = path.dirname(SDK_PROJECT_PATH);

suite("vbprojParser: SDK スタイル(sdk-style/SdkBasic fixture)", () => {
  const result = parseFixture("sdk-style/SdkBasic/SdkBasic.vbproj");
  const includes = () => result.items.map((item) => item.include).sort();

  test("Sdk 属性で sdk と判定し、既定グロブを展開したことを記録する", () => {
    assert.strictEqual(result.projectStyle, "sdk");
    assert.strictEqual(result.defaultCompileGlobExpanded, true);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.severity === "info" &&
          d.message.includes("既定の Compile グロブ(**/*.vb)を展開しました") &&
          d.message.includes("MSBuild の完全評価ではありません"),
      ),
    );
  });

  test("明示 Include + 展開した .vb が揃い、bin/obj/ドットフォルダ/Remove は入らない", () => {
    assert.deepStrictEqual(includes(), [
      "..\\Shared\\Helper.vb",
      "Api\\Service.vb",
      "Forms\\MainForm.Designer.vb",
      "Forms\\MainForm.vb",
      "Legacy\\Explicit.vb",
      "Program.vb",
    ]);
    assert.ok(result.items.every((item) => item.status === "resolved" && item.exists));
  });

  test("明示 Include とグロブの両方に一致するファイルは重複しない", () => {
    const explicit = result.items.filter((item) =>
      /Explicit\.vb$/i.test(item.include),
    );
    assert.strictEqual(explicit.length, 1);
    assert.ok(result.diagnostics.some((d) => d.message.includes("明示 Include と重複 1 件")));
  });

  test("Link 属性の項目は論理パスに Link を使う", () => {
    const helper = findItem(result, "..\\Shared\\Helper.vb");
    assert.strictEqual(helper.logicalPath, "Shared\\Helper.vb");
    assert.strictEqual(helper.link, "Shared\\Helper.vb");
  });

  test("Compile Update のメタデータ(SubType / DependentUpon)が展開項目に付与される", () => {
    const form = findItem(result, "Forms\\MainForm.vb");
    assert.strictEqual(form.subType, "Form");
    const designer = findItem(result, "Forms\\MainForm.Designer.vb");
    assert.strictEqual(designer.dependentUpon, "MainForm.vb");
    assert.strictEqual(designer.isSensitive, true);
  });

  test("展開した項目は Include が `\\` 区切りの相対パスで、論理パスと一致する", () => {
    const service = findItem(result, "Api\\Service.vb");
    assert.strictEqual(service.logicalPath, "Api\\Service.vb");
    assert.ok(service.sourcePath !== undefined && path.isAbsolute(service.sourcePath));
    assert.deepStrictEqual(service.metadata, {});
  });

  test("PackageReference / ProjectReference は従来どおり未対応として診断に載る", () => {
    assert.ok(result.diagnostics.some((d) => d.message.includes("PackageReference ×1")));
  });
});

suite("vbprojParser: SDK スタイル(Import Sdk 形式 + EnableDefaultCompileItems=false)", () => {
  const result = parseFixture("sdk-style/SdkNoDefault/SdkNoDefault.vbproj");

  test("<Import Sdk=\"...\"> でも sdk と判定する", () => {
    assert.strictEqual(result.projectStyle, "sdk");
  });

  test("既定グロブを展開せず、明示した項目だけになる", () => {
    assert.strictEqual(result.defaultCompileGlobExpanded, false);
    assert.deepStrictEqual(
      result.items.map((item) => item.include),
      ["Only.vb"],
    );
    assert.ok(
      result.diagnostics.some((d) => d.message.includes("EnableDefaultCompileItems=false")),
    );
  });
});

suite("vbprojParser: SDK スタイル(fake fs)", () => {
  const sdkXml = (body: string): string =>
    `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>`;

  test("DefaultItemExcludes の追加パターンを適用し、$(DefaultItemExcludes) 参照は黙って引き継ぐ", () => {
    const deps = fakeSdkDeps(SDK_PROJECT_DIR, [
      "A.vb",
      "Legacy/Old.vb",
      "Gen/X.Generated.vb",
      "bin/Debug/B.vb",
    ]);
    const xml = sdkXml(`
  <PropertyGroup>
    <DefaultItemExcludes>$(DefaultItemExcludes);Legacy\\**;$(SomethingElse)</DefaultItemExcludes>
  </PropertyGroup>
  <ItemGroup>
    <Compile Remove="**\\*.Generated.vb" />
  </ItemGroup>`);
    const result = parseVbproj(xml, SDK_PROJECT_PATH, deps);
    assert.deepStrictEqual(result.items.map((item) => item.include), ["A.vb"]);
    assert.ok(result.diagnostics.some((d) => d.message.includes("除外 3 件")));
    assert.ok(
      result.diagnostics.some((d) => d.message.includes("無視しました: $(SomethingElse)")),
    );
    assert.ok(
      !result.diagnostics.some((d) => d.message.includes("$(DefaultItemExcludes)")),
    );
  });

  test("listFilesRecursive がなければ展開せず警告する(クラッシュしない)", () => {
    const result = parseVbproj(sdkXml(""), SDK_PROJECT_PATH, {
      fileExists: () => false,
    });
    assert.strictEqual(result.projectStyle, "sdk");
    assert.strictEqual(result.defaultCompileGlobExpanded, false);
    assert.strictEqual(result.items.length, 0);
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("展開できません"),
      ),
    );
  });

  test("ディレクトリを走査できない(undefined)ときも警告して続行する", () => {
    const result = parseVbproj(sdkXml(""), SDK_PROJECT_PATH, {
      fileExists: () => false,
      listFilesRecursive: () => undefined,
    });
    assert.strictEqual(result.defaultCompileGlobExpanded, false);
    assert.ok(result.diagnostics.some((d) => d.severity === "warning"));
  });

  test("<Sdk Name=\"...\"> 要素でも sdk と判定する", () => {
    const deps = fakeSdkDeps(SDK_PROJECT_DIR, ["A.vb"]);
    const result = parseVbproj(
      `<Project>\n  <Sdk Name="Microsoft.NET.Sdk" />\n</Project>`,
      SDK_PROJECT_PATH,
      deps,
    );
    assert.strictEqual(result.projectStyle, "sdk");
    assert.deepStrictEqual(result.items.map((item) => item.include), ["A.vb"]);
  });

  test("Update に一致する項目がなければ info を残す。Compile 以外の Remove は未対応として記録", () => {
    const deps = fakeSdkDeps(SDK_PROJECT_DIR, ["A.vb"]);
    const xml = sdkXml(`
  <ItemGroup>
    <Compile Update="Nothing.vb"><SubType>Form</SubType></Compile>
    <None Remove="x.txt" />
  </ItemGroup>`);
    const result = parseVbproj(xml, SDK_PROJECT_PATH, deps);
    assert.ok(result.diagnostics.some((d) => d.message.includes('Update="Nothing.vb"')));
    assert.ok(result.diagnostics.some((d) => d.message.includes('<None Remove="x.txt">')));
  });

  test("Condition 付き PropertyGroup の値は評価せず採用し、その旨を記録する", () => {
    const deps = fakeSdkDeps(SDK_PROJECT_DIR, ["A.vb"]);
    const xml = sdkXml(`
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>`);
    const result = parseVbproj(xml, SDK_PROJECT_PATH, deps);
    assert.strictEqual(result.defaultCompileGlobExpanded, false);
    assert.ok(result.diagnostics.some((d) => d.message.includes("Condition 付きですが評価せず")));
  });
});

suite("vbprojParser: 旧スタイルは SDK 対応の影響を受けない", () => {
  test("basic fixture は legacy のまま、走査手段があっても展開しない", () => {
    const result = parseFixture("basic/Basic.vbproj");
    assert.strictEqual(result.projectStyle, "legacy");
    assert.strictEqual(result.defaultCompileGlobExpanded, false);
    assert.strictEqual(result.items.length, 7);
  });

  test("edge-cases のワイルドカード Include は引き続き wildcard(展開しない)", () => {
    const result = parseFixture("edge-cases/EdgeCases.vbproj", {
      fileExists: () => false,
      listFilesRecursive: () => [],
    });
    assert.strictEqual(result.projectStyle, "legacy");
    assert.strictEqual(findItem(result, "Common\\**\\*.vb").status, "wildcard");
  });

  test("旧スタイルの Compile Remove は適用対象なしとして info に残す", () => {
    const xml = `<Project ToolsVersion="12.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Compile Include="A.vb" />
    <Compile Remove="B.vb" />
  </ItemGroup>
</Project>`;
    const result = parseVbproj(xml, SDK_PROJECT_PATH, { fileExists: () => true });
    assert.deepStrictEqual(result.items.map((item) => item.include), ["A.vb"]);
    assert.ok(result.diagnostics.some((d) => d.message.includes("<Compile Remove> ×1")));
    assert.ok(!result.diagnostics.some((d) => d.message.includes("Include 属性のない")));
  });
});
