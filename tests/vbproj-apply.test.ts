/**
 * create した .vb の .vbproj 自動登録 (設計書 §11.1) と新規ファイルの形式推定 (§11.2) の統合テスト。
 * 完了条件 (§16 P1): Shift_JIS / CRLF の .vbproj で他の行を 1 バイトも変えない、SDK スタイルは
 * 登録しない、undo で戻る、auto の推定がフィクスチャと一致、.vb の BOM なし UTF-8 を作らない。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { undoCommand } from "../src/commands/undo.ts";
import { sjisEncode } from "../src/core/sjis.ts";
import type { Manifest } from "../src/infra/history.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sjis = (s: string): Uint8Array => sjisEncode(s).bytes;
const doc = (...lines: string[]): string => lines.join("\n");
const BOM = [0xef, 0xbb, 0xbf];

const VBPROJ_LINES = [
  '<?xml version="1.0" encoding="shift_jis"?>',
  '<Project ToolsVersion="12.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
  "  <PropertyGroup>",
  "    <AssemblyName>受注管理</AssemblyName>",
  "  </PropertyGroup>",
  "  <ItemGroup>",
  '    <Compile Include="Forms\\MainForm.vb">',
  "      <SubType>Form</SubType>",
  "    </Compile>",
  '    <Compile Include="Services\\Existing.vb" />',
  "  </ItemGroup>",
  "</Project>",
];
/** Shift_JIS + CRLF + 末尾改行なし */
const VBPROJ = sjis(VBPROJ_LINES.join("\r\n"));

function setup(config: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "petari-vbproj-"));
  mkdirSync(join(dir, "App", "Services"), { recursive: true });
  mkdirSync(join(dir, "App", "Forms"), { recursive: true });
  writeFileSync(join(dir, "App", "App.vbproj"), VBPROJ);
  writeFileSync(join(dir, "App", "Services", "Existing.vb"), sjis("' 既存\r\nEnd Module\r\n"));
  writeFileSync(join(dir, "App", "Services", "Other.vb"), sjis("' 既存2\r\nEnd Module\r\n"));
  mkdirSync(join(dir, ".petari"), { recursive: true });
  writeFileSync(
    join(dir, ".petari", "config.json"),
    JSON.stringify({ clipReportOnFailure: false, ...config }),
    "utf8",
  );
  return dir;
}

function manifestOf(dir: string): Manifest {
  const ids = readdirSync(join(dir, ".petari", "history"));
  return JSON.parse(
    readFileSync(join(dir, ".petari", "history", ids[0] as string, "manifest.json"), "utf8"),
  ) as Manifest;
}

async function apply(dir: string, changes: string, extra: string[] = []): Promise<number> {
  // changes.md はルートの外に置く (ルート直下に置くと形式推定の手本に数えられる)
  const path = join(mkdtempSync(join(tmpdir(), "petari-changes-")), "changes.md");
  writeFileSync(path, changes, "utf8");
  return applyCommand([path, "--root", dir, "--yes", ...extra]);
}

const CREATE_SERVICE = doc(
  "## CHANGES",
  "",
  "サービス追加。",
  "",
  "### FILE: App/Services/OrderService.vb (create)",
  "<<<<<<< CONTENT",
  "' 受注サービス",
  "Public Class OrderService",
  "End Class",
  ">>>>>>> END",
);

describe("apply: .vbproj への自動登録 (§11.1)", () => {
  it("旧スタイル .vbproj に Compile を追加し、他の行は 1 バイトも変えない (Shift_JIS + CRLF)", async () => {
    const dir = setup({ newFile: { encoding: "auto" } });
    expect(await apply(dir, CREATE_SERVICE)).toBe(0);

    const expected = [...VBPROJ_LINES];
    expected.splice(10, 0, '    <Compile Include="Services\\OrderService.vb" />');
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(
      sjis(expected.join("\r\n")),
    );
    // 新規 .vb は同ディレクトリの手本 (shift_jis / crlf) に合わせる
    expect(new Uint8Array(readFileSync(join(dir, "App", "Services", "OrderService.vb")))).toEqual(
      sjis("' 受注サービス\r\nPublic Class OrderService\r\nEnd Class\r\n"),
    );

    // 履歴: .vbproj も before/after と manifest に載る (undo の対象)
    const m = manifestOf(dir);
    const entry = m.files.find((f) => f.path === "App/App.vbproj");
    expect(entry?.op).toBe("vbproj");
    expect(entry?.applied).toBe(true);
    expect(entry?.registered).toEqual(["App/Services/OrderService.vb"]);
    expect(entry?.beforeSha256).toMatch(/^[0-9a-f]{64}$/);
    const hdir = join(dir, ".petari", "history", m.id);
    expect(new Uint8Array(readFileSync(join(hdir, "before", "App", "App.vbproj")))).toEqual(VBPROJ);
    expect(existsSync(join(hdir, "after", "App", "App.vbproj"))).toBe(true);
  });

  it("undo で登録も元に戻る", async () => {
    const dir = setup();
    expect(await apply(dir, CREATE_SERVICE)).toBe(0);
    expect(await undoCommand(["--root", dir, "--yes"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(VBPROJ);
    expect(existsSync(join(dir, "App", "Services", "OrderService.vb"))).toBe(false);
  });

  it("Form には SubType、X.Designer.vb には DependentUpon を付ける (同じ changes.md 内で両方 create)", async () => {
    const dir = setup();
    const changes = doc(
      "## CHANGES",
      "",
      "フォーム追加。",
      "",
      // Designer を先に書いても登録順は親 → Designer
      "### FILE: App/Forms/OrderForm.Designer.vb (create)",
      "<<<<<<< CONTENT",
      "Partial Class OrderForm",
      "    Inherits System.Windows.Forms.Form",
      "End Class",
      ">>>>>>> END",
      "",
      "### FILE: App/Forms/OrderForm.vb (create)",
      "<<<<<<< CONTENT",
      "Public Class OrderForm",
      "    Inherits System.Windows.Forms.Form",
      "End Class",
      ">>>>>>> END",
    );
    expect(await apply(dir, changes)).toBe(0);
    const text = new TextDecoder("shift_jis").decode(readFileSync(join(dir, "App", "App.vbproj")));
    const lines = text.split("\r\n");
    const at = lines.indexOf('    <Compile Include="Services\\Existing.vb" />');
    expect(lines.slice(at + 1, at + 8)).toEqual([
      '    <Compile Include="Forms\\OrderForm.vb">',
      "      <SubType>Form</SubType>",
      "    </Compile>",
      '    <Compile Include="Forms\\OrderForm.Designer.vb">',
      "      <DependentUpon>OrderForm.vb</DependentUpon>",
      "    </Compile>",
      "  </ItemGroup>",
    ]);
    const entry = manifestOf(dir).files.find((f) => f.path === "App/App.vbproj");
    expect(entry?.registered).toEqual(["App/Forms/OrderForm.vb", "App/Forms/OrderForm.Designer.vb"]);
  });

  it("SDK スタイルの .vbproj には登録しない", async () => {
    const dir = setup();
    mkdirSync(join(dir, "dotnet", "Impl"), { recursive: true });
    const sdk = utf8('<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n  </PropertyGroup>\n</Project>\n');
    writeFileSync(join(dir, "dotnet", "Impl", "Impl.vbproj"), sdk);
    const changes = doc(
      "## CHANGES",
      "",
      "SDK 側に追加。",
      "",
      "### FILE: dotnet/Impl/Api.vb (create)",
      "<<<<<<< CONTENT",
      "Public Class Api",
      "End Class",
      ">>>>>>> END",
    );
    expect(await apply(dir, changes)).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "dotnet", "Impl", "Impl.vbproj")))).toEqual(sdk);
    expect(manifestOf(dir).files.some((f) => f.op === "vbproj")).toBe(false);
  });

  it("vbproj が見つからない / 複数ある場合は登録せず create は成功する", async () => {
    const dir = setup();
    writeFileSync(join(dir, "App", "Forms", "A.vbproj"), VBPROJ);
    writeFileSync(join(dir, "App", "Forms", "B.vbproj"), VBPROJ);
    const changes = doc(
      "## CHANGES",
      "",
      "テスト。",
      "",
      "### FILE: Tools/Helper.vb (create)",
      "<<<<<<< CONTENT",
      "Module Helper",
      "End Module",
      ">>>>>>> END",
      "",
      "### FILE: App/Forms/Two.vb (create)",
      "<<<<<<< CONTENT",
      "Public Class Two",
      "End Class",
      ">>>>>>> END",
    );
    expect(await apply(dir, changes)).toBe(0);
    expect(existsSync(join(dir, "Tools", "Helper.vb"))).toBe(true);
    expect(existsSync(join(dir, "App", "Forms", "Two.vb"))).toBe(true);
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(VBPROJ);
    expect(new Uint8Array(readFileSync(join(dir, "App", "Forms", "A.vbproj")))).toEqual(VBPROJ);
  });

  it("登録済みなら .vbproj に触れない (冪等)", async () => {
    const dir = setup();
    const changes = doc(
      "## CHANGES",
      "",
      "既存を再作成。",
      "",
      "### FILE: App/Services/Registered.vb (create)",
      "<<<<<<< CONTENT",
      "Module Registered",
      "End Module",
      ">>>>>>> END",
    );
    const registered = sjis(
      [...VBPROJ_LINES.slice(0, 10), '    <Compile Include="Services\\Registered.vb" />', ...VBPROJ_LINES.slice(10)].join("\r\n"),
    );
    writeFileSync(join(dir, "App", "App.vbproj"), registered);
    expect(await apply(dir, changes)).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(registered);
    expect(manifestOf(dir).files.some((f) => f.op === "vbproj")).toBe(false);
  });

  it("--no-vbproj と config vbproj.register: false で無効化できる", async () => {
    for (const [config, extra] of [
      [{}, ["--no-vbproj"]],
      [{ vbproj: { register: false } }, []],
    ] as const) {
      const dir = setup({ ...config });
      expect(await apply(dir, CREATE_SERVICE, [...extra])).toBe(0);
      expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(VBPROJ);
      expect(existsSync(join(dir, "App", "Services", "OrderService.vb"))).toBe(true);
    }
  });

  it("changes.md が同じ .vbproj を変更する場合は、その変更後の内容に登録を重ねる", async () => {
    const dir = setup();
    const changes = doc(
      "## CHANGES",
      "",
      "vbproj も触る。",
      "",
      "### FILE: App/App.vbproj (replace)",
      "<<<<<<< SEARCH",
      "    <AssemblyName>受注管理</AssemblyName>",
      "=======",
      "    <AssemblyName>受注管理2</AssemblyName>",
      ">>>>>>> REPLACE",
      "",
      "### FILE: App/Services/OrderService.vb (create)",
      "<<<<<<< CONTENT",
      "Public Class OrderService",
      "End Class",
      ">>>>>>> END",
    );
    expect(await apply(dir, changes)).toBe(0);
    const expected = [...VBPROJ_LINES];
    expected[3] = "    <AssemblyName>受注管理2</AssemblyName>";
    expected.splice(10, 0, '    <Compile Include="Services\\OrderService.vb" />');
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(
      sjis(expected.join("\r\n")),
    );
    const m = manifestOf(dir);
    const entry = m.files.find((f) => f.path === "App/App.vbproj");
    expect(entry?.op).toBe("replace");
    expect(entry?.registered).toEqual(["App/Services/OrderService.vb"]);
    expect(m.files.filter((f) => f.path === "App/App.vbproj")).toHaveLength(1);
    // undo は AI の変更と登録の両方を戻す
    expect(await undoCommand(["--root", dir, "--yes"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(VBPROJ);
  });

  it("--dry-run では .vbproj を書かない", async () => {
    const dir = setup();
    expect(await apply(dir, CREATE_SERVICE, ["--dry-run"])).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "App", "App.vbproj")))).toEqual(VBPROJ);
    expect(existsSync(join(dir, ".petari", "history"))).toBe(false);
  });
});

describe("apply: 新規ファイルの形式推定 newFile.encoding auto (§11.2)", () => {
  it("手本のない .vb は utf8 + BOM + crlf、.ts は utf8 / lf で作る", async () => {
    const dir = setup({ newFile: { encoding: "auto" }, vbproj: { register: false } });
    mkdirSync(join(dir, "Lib"), { recursive: true });
    const changes = doc(
      "## CHANGES",
      "",
      "テスト。",
      "",
      "### FILE: Lib/New.vb (create)",
      "<<<<<<< CONTENT",
      "' 日本語",
      ">>>>>>> END",
      "",
      "### FILE: Lib/new.ts (create)",
      "<<<<<<< CONTENT",
      "export const x = 1;",
      ">>>>>>> END",
    );
    expect(await apply(dir, changes)).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "Lib", "New.vb")))).toEqual(
      new Uint8Array([...BOM, ...utf8("' 日本語\r\n")]),
    );
    expect(new Uint8Array(readFileSync(join(dir, "Lib", "new.ts")))).toEqual(utf8("export const x = 1;\n"));
  });

  it("同ディレクトリの .vb が BOM なし UTF-8 (ASCII のみ) でも .vb には BOM を付ける", async () => {
    const dir = setup({ newFile: { encoding: "auto" }, vbproj: { register: false } });
    mkdirSync(join(dir, "Lib"), { recursive: true });
    writeFileSync(join(dir, "Lib", "A.vb"), utf8("' ascii only\r\n"));
    const changes = doc(
      "## CHANGES",
      "",
      "テスト。",
      "",
      "### FILE: Lib/New.vb (create)",
      "<<<<<<< CONTENT",
      "' 日本語",
      ">>>>>>> END",
    );
    expect(await apply(dir, changes)).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "Lib", "New.vb")))).toEqual(
      new Uint8Array([...BOM, ...utf8("' 日本語\r\n")]),
    );
  });

  it("明示設定 (utf8 / lf) は従来どおり手本を見ない", async () => {
    const dir = setup({ newFile: { encoding: "utf8", eol: "lf" }, vbproj: { register: false } });
    expect(await apply(dir, CREATE_SERVICE)).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "App", "Services", "OrderService.vb")))).toEqual(
      utf8("' 受注サービス\nPublic Class OrderService\nEnd Class\n"),
    );
  });
});
