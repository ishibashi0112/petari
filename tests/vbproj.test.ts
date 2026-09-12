import { describe, expect, it } from "vitest";
import {
  applyInsertion,
  designerParentName,
  detectSubType,
  isSdkStyleVbproj,
  registerCompileItem,
  toIncludePath,
} from "../src/core/vbproj.ts";

const OLD_STYLE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Project ToolsVersion="12.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
  '  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" />',
  "  <PropertyGroup>",
  "    <OutputType>WinExe</OutputType>",
  "  </PropertyGroup>",
  "  <ItemGroup>",
  '    <Reference Include="System" />',
  "  </ItemGroup>",
  "  <ItemGroup>",
  '    <Compile Include="Forms\\MainForm.vb">',
  "      <SubType>Form</SubType>",
  "    </Compile>",
  '    <Compile Include="Forms\\MainForm.Designer.vb">',
  "      <DependentUpon>MainForm.vb</DependentUpon>",
  "    </Compile>",
  '    <Compile Include="Services\\Existing.vb" />',
  "  </ItemGroup>",
  "  <ItemGroup>",
  '    <EmbeddedResource Include="Forms\\MainForm.resx">',
  "      <DependentUpon>MainForm.vb</DependentUpon>",
  "    </EmbeddedResource>",
  "  </ItemGroup>",
  '  <Import Project="$(MSBuildToolsPath)\\Microsoft.VisualBasic.targets" />',
  "</Project>",
];

function insertOf(lines: string[], include: string, opts?: { subType?: string; dependentUpon?: string }) {
  const r = registerCompileItem(lines, include, opts);
  if (r.status !== "insert") throw new Error(`insert ではない: ${r.status}`);
  return r;
}

describe("registerCompileItem (設計書 §11.1)", () => {
  it("Compile 項目を含む最初の ItemGroup の末尾に、既存項目と同じインデントで追加する", () => {
    const r = insertOf(OLD_STYLE, "Services\\OrderService.vb");
    expect(r.inserted).toEqual(['    <Compile Include="Services\\OrderService.vb" />']);
    // 挿入位置は Compile を含む ItemGroup の </ItemGroup> の直前
    expect(OLD_STYLE[r.at]).toBe("  </ItemGroup>");
    expect(OLD_STYLE[r.at - 1]).toBe('    <Compile Include="Services\\Existing.vb" />');
    const after = applyInsertion(OLD_STYLE, r);
    expect(after).toHaveLength(OLD_STYLE.length + 1);
    // 他の行は一切変わらない
    expect([...after.slice(0, r.at), ...after.slice(r.at + 1)]).toEqual(OLD_STYLE);
  });

  it("SubType / DependentUpon は子要素として追加し、子のインデントは既存に合わせる", () => {
    const form = insertOf(OLD_STYLE, "Forms\\OrderForm.vb", { subType: "Form" });
    expect(form.inserted).toEqual([
      '    <Compile Include="Forms\\OrderForm.vb">',
      "      <SubType>Form</SubType>",
      "    </Compile>",
    ]);
    const designer = insertOf(OLD_STYLE, "Forms\\OrderForm.Designer.vb", {
      dependentUpon: "OrderForm.vb",
    });
    expect(designer.inserted).toEqual([
      '    <Compile Include="Forms\\OrderForm.Designer.vb">',
      "      <DependentUpon>OrderForm.vb</DependentUpon>",
      "    </Compile>",
    ]);
  });

  it("既に登録済み (区切り・大文字小文字の差を含む) なら何もしない (冪等)", () => {
    expect(registerCompileItem(OLD_STYLE, "Services\\Existing.vb")).toEqual({ status: "registered" });
    expect(registerCompileItem(OLD_STYLE, "services/existing.vb")).toEqual({ status: "registered" });
  });

  it("Compile 項目を含む ItemGroup がなければ最後の ItemGroup の後に新しい ItemGroup を作る", () => {
    const lines = [
      '<Project ToolsVersion="12.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      "  <ItemGroup>",
      '    <Reference Include="System" />',
      "  </ItemGroup>",
      '  <Import Project="x.targets" />',
      "</Project>",
    ];
    const r = insertOf(lines, "A.vb");
    expect(r.at).toBe(4);
    expect(r.inserted).toEqual(["  <ItemGroup>", '    <Compile Include="A.vb" />', "  </ItemGroup>"]);
  });

  it("ItemGroup が皆無なら </Project> の直前に作る (既定 4 スペース)", () => {
    const lines = ["<Project>", "  <PropertyGroup>", "  </PropertyGroup>", "</Project>"];
    const r = insertOf(lines, "A.vb");
    expect(r.at).toBe(3);
    expect(r.inserted).toEqual(["  <ItemGroup>", '    <Compile Include="A.vb" />', "  </ItemGroup>"]);
  });

  it("Condition 付きの ItemGroup は対象にしない", () => {
    const lines = [
      "<Project>",
      "  <ItemGroup Condition=\"'$(Configuration)' == 'Debug'\">",
      '    <Compile Include="DebugOnly.vb" />',
      "  </ItemGroup>",
      "  <ItemGroup>",
      '    <Compile Include="A.vb" />',
      "  </ItemGroup>",
      "</Project>",
    ];
    const r = insertOf(lines, "B.vb");
    expect(r.at).toBe(6);
  });

  it("タブインデントにも追従する", () => {
    const lines = ["<Project>", "\t<ItemGroup>", '\t\t<Compile Include="A.vb" />', "\t</ItemGroup>", "</Project>"];
    const r = insertOf(lines, "B.vb");
    expect(r.inserted).toEqual(['\t\t<Compile Include="B.vb" />']);
  });

  it("Include の特殊文字は XML エスケープする", () => {
    const r = insertOf(OLD_STYLE, "A&B\\C.vb");
    expect(r.inserted).toEqual(['    <Compile Include="A&amp;B\\C.vb" />']);
    // エスケープ済みの既存項目とも同一視する
    const lines = ["<Project>", "  <ItemGroup>", '    <Compile Include="A&amp;B\\C.vb" />', "  </ItemGroup>", "</Project>"];
    expect(registerCompileItem(lines, "A&B\\C.vb")).toEqual({ status: "registered" });
  });

  it("SDK スタイル (Project Sdk 属性 / Sdk.props Import) は登録不要", () => {
    expect(registerCompileItem(['<Project Sdk="Microsoft.NET.Sdk">', "</Project>"], "A.vb")).toEqual({
      status: "sdk-style",
    });
    expect(
      registerCompileItem(
        ["<Project>", '  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />', "</Project>"],
        "A.vb",
      ),
    ).toEqual({ status: "sdk-style" });
    expect(isSdkStyleVbproj(OLD_STYLE)).toBe(false);
  });

  it("登録できない形式は unsupported (壊さない)", () => {
    const cases: [string, string[]][] = [
      ["1 行に複数要素", ["<Project>", '  <ItemGroup><Compile Include="A.vb" /></ItemGroup>', "</Project>"]],
      ["Compile 要素が 1 行 1 要素でない", ["<Project>", "  <ItemGroup>", '    <Compile Include="A.vb"><SubType>Form</SubType></Compile>', "  </ItemGroup>", "</Project>"]],
      ["CDATA", ["<Project>", "  <ItemGroup>", '    <Compile Include="A.vb" />', "  </ItemGroup>", "  <![CDATA[ x ]]>", "</Project>"]],
      ["閉じタグ欠落", ["<Project>", "  <ItemGroup>", '    <Compile Include="A.vb" />', "</Project>"]],
      ["Project 要素なし", ["<Foo>", "</Foo>"]],
      ["</Project> なし", ["<Project>", "  <PropertyGroup>", "  </PropertyGroup>"]],
    ];
    for (const [label, lines] of cases) {
      const r = registerCompileItem(lines, "B.vb");
      expect(r.status, label).toBe("unsupported");
    }
  });
});

describe("detectSubType / designerParentName / toIncludePath", () => {
  it("Inherits Form / UserControl (完全修飾・コメント付きを含む) を検出する", () => {
    expect(detectSubType(["Public Class F", "    Inherits System.Windows.Forms.Form", "End Class"])).toBe("Form");
    expect(detectSubType(["Public Class F", "    inherits Form ' base", "End Class"])).toBe("Form");
    expect(detectSubType(["Public Class C", "    Inherits Windows.Forms.UserControl", "End Class"])).toBe(
      "UserControl",
    );
    expect(detectSubType(["Public Class S", "    Inherits BaseService", "End Class"])).toBeUndefined();
    expect(detectSubType(["Public Class S", "End Class"])).toBeUndefined();
  });

  it("X.Designer.vb → X.vb (大文字小文字を区別しない)", () => {
    expect(designerParentName("OrderForm.Designer.vb")).toBe("OrderForm.vb");
    expect(designerParentName("OrderForm.designer.VB")).toBe("OrderForm.vb");
    expect(designerParentName("OrderForm.vb")).toBeNull();
  });

  it("ルート相対パスを .vbproj からの相対 Include (\\ 区切り) にする", () => {
    expect(toIncludePath("App", "App/Services/OrderService.vb")).toBe("Services\\OrderService.vb");
    expect(toIncludePath("", "Services/OrderService.vb")).toBe("Services\\OrderService.vb");
    expect(toIncludePath("App", "App/Main.vb")).toBe("Main.vb");
    expect(toIncludePath("App/Sub", "App/Other/X.vb")).toBe("..\\Other\\X.vb");
  });
});
