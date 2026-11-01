/**
 * repomixExporter の単体テスト。
 * ファイル読み込みは fake を注入し、basic fixture の解析結果で検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { sjisEncode } from "../../src/core/sjis.ts";
import {
  buildRepomixOutput,
  decodeSourceBuffer,
  relativeWithinRoot,
  type RepomixSource,
} from "../../src/pack/services/repomixExporter.ts";
import type { VbprojParseResult } from "../../src/pack/types.ts";
import { parseVbproj } from "../../src/pack/vbprojParser.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

function parseBasic(): VbprojParseResult {
  const projectPath = path.join(FIXTURES_ROOT, "basic", "Basic.vbproj");
  return parseVbproj(fs.readFileSync(projectPath, "utf8"), projectPath, {
    fileExists: (p) => fs.existsSync(p),
  });
}

/** どのファイルにも同じ内容を返す fake reader */
const fakeDeps = {
  readTextFile: (absolutePath: string): string | undefined =>
    `' content of ${path.basename(absolutePath)}`,
};

suite("repomixExporter: buildRepomixOutput", () => {
  const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
  const result = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
    includeSensitive: false,
    maskCredentials: false,
  });

  test("Repomix 形式のセクション構造を持つ", () => {
    for (const section of [
      "<file_summary>",
      "<directory_structure>",
      "<files>",
      "<skipped_files>",
    ]) {
      assert.ok(result.content.includes(section), `${section} がありません`);
    }
  });

  test("論理ツリーが directory_structure に出力される", () => {
    assert.ok(result.content.includes("Basic/"));
    assert.ok(result.content.includes("  Forms/"));
    assert.ok(result.content.includes("    OrderForm.vb"));
  });

  test("通常のソースは論理パス付きで内容が含まれる", () => {
    assert.ok(result.content.includes('<file path="Basic\\Module1.vb">'));
    assert.ok(result.content.includes("' content of Module1.vb"));
    assert.ok(result.content.includes('<file path="Basic\\Forms\\OrderForm.vb">'));
  });

  test("Designer 関連は既定で除外され、理由付きでスキップ一覧に載る", () => {
    assert.ok(
      !result.content.includes('<file path="Basic\\Forms\\OrderForm.Designer.vb"'),
    );
    const skippedDesigner = result.skipped.find(
      (s) => s.path === "Basic\\Forms\\OrderForm.Designer.vb",
    );
    assert.ok(skippedDesigner !== undefined);
    assert.ok(skippedDesigner.reason.includes("Designer"));
  });

  test("EmbeddedResource(.resx)は常に除外される", () => {
    assert.ok(!result.content.includes('<file path="Basic\\Forms\\OrderForm.resx"'));
    assert.ok(
      result.skipped.some((s) => s.path === "Basic\\Forms\\OrderForm.resx"),
    );
  });

  test("件数・文字数の統計が返る", () => {
    // Module1.vb / OrderForm.vb / App.config の 3 件(Designer 系・resx は除外)
    assert.strictEqual(result.fileCount, 3);
    assert.ok(result.totalChars > 0);
    // filePaths は出力した <file> の path 属性と同じ(除外したものは含まない)
    assert.strictEqual(result.filePaths.length, result.fileCount);
    assert.ok(result.filePaths.includes("Basic\\Module1.vb"));
    assert.ok(result.filePaths.includes("Basic\\Forms\\OrderForm.vb"));
    assert.ok(!result.filePaths.includes("Basic\\Forms\\OrderForm.Designer.vb"));
  });

  test("includeSensitive で Designer 関連も含められる", () => {
    const withSensitive = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
      includeSensitive: true,
      maskCredentials: false,
    });
    assert.ok(
      withSensitive.content.includes(
        '<file path="Basic\\Forms\\OrderForm.Designer.vb">',
      ),
    );
    // resx は includeSensitive でも除外のまま
    assert.ok(
      !withSensitive.content.includes('<file path="Basic\\Forms\\OrderForm.resx"'),
    );
  });

  test("includeSensitive に述語を渡すと一致した Designer だけ含める", () => {
    const selective = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
      includeSensitive: (logicalPath) =>
        logicalPath === "Forms\\OrderForm.Designer.vb",
      maskCredentials: false,
    });
    assert.ok(
      selective.content.includes(
        '<file path="Basic\\Forms\\OrderForm.Designer.vb">',
      ),
    );
    assert.ok(
      !selective.content.includes(
        '<file path="Basic\\My Project\\Application.Designer.vb"',
      ),
    );
    assert.ok(
      selective.skipped.some(
        (s) =>
          s.path === "Basic\\My Project\\Application.Designer.vb" &&
          s.reason.includes("Designer"),
      ),
    );
    // resx は述語でも常に除外
    assert.ok(
      !selective.content.includes('<file path="Basic\\Forms\\OrderForm.resx"'),
    );
  });

  test("読み込み失敗はスキップ一覧に載る", () => {
    const failing = buildRepomixOutput(
      "Basic.vbproj",
      sources,
      { readTextFile: () => undefined },
      { includeSensitive: false, maskCredentials: false },
    );
    assert.strictEqual(failing.fileCount, 0);
    assert.ok(
      failing.skipped.some((s) => s.reason.includes("読み込みに失敗")),
    );
  });
});

suite("repomixExporter: 認証情報マスク統合", () => {
  test("マスク有効時は内容が置換され masked_credentials に記録される", () => {
    const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
    const secretDeps = {
      readTextFile: (absolutePath: string): string | undefined =>
        absolutePath.toLowerCase().endsWith(".vb")
          ? 'Public Pub_DB_Pswd As String = "inf001"'
          : "Password=inf001;",
    };
    const result = buildRepomixOutput("Basic.vbproj", sources, secretDeps, {
      includeSensitive: false,
      maskCredentials: true,
    });
    assert.ok(!result.content.includes("inf001"));
    assert.ok(result.content.includes('= "[MASKED]"'));
    assert.ok(result.content.includes("<masked_credentials>"));
    assert.ok(result.content.includes("パスワード"));
    assert.ok(result.maskedCount > 0);
    assert.ok(
      result.maskedFiles.some((f) => f.path === "Basic\\Module1.vb"),
    );
  });

  test("マスク無効時はそのまま出力され、無効であることが明記される", () => {
    const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
    const secretDeps = {
      readTextFile: (absolutePath: string): string | undefined =>
        absolutePath.toLowerCase().endsWith(".vb")
          ? 'Public Pub_DB_Pswd As String = "inf001"'
          : "Password=inf001;",
    };
    const result = buildRepomixOutput("Basic.vbproj", sources, secretDeps, {
      includeSensitive: false,
      maskCredentials: false,
    });
    assert.ok(result.content.includes("inf001"));
    assert.strictEqual(result.maskedCount, 0);
    assert.ok(result.content.includes("マスク機能は設定で無効化"));
  });
});

suite("repomixExporter: .gitignore 連携", () => {
  test("ignoreReasonFor が除外を返したファイルはスキップされ理由が明記される", () => {
    const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
    const result = buildRepomixOutput(
      "Basic.vbproj",
      sources,
      {
        readTextFile: fakeDeps.readTextFile,
        ignoreReasonFor: (absolutePath) =>
          absolutePath.endsWith("Module1.vb") ? "/base/.gitignore" : undefined,
      },
      { includeSensitive: false, maskCredentials: false },
    );
    assert.ok(!result.content.includes('<file path="Basic\\Module1.vb">'));
    assert.ok(
      result.skipped.some(
        (s) =>
          s.path === "Basic\\Module1.vb" &&
          s.reason.includes(".gitignore により除外"),
      ),
    );
    assert.ok(result.content.includes("本家 repomix と同様"));
  });

  test("ignoreReasonFor 未指定なら従来どおり全ファイルを含める", () => {
    const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
    const result = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
      includeSensitive: false,
      maskCredentials: false,
    });
    assert.ok(result.content.includes('<file path="Basic\\Module1.vb">'));
    assert.ok(result.content.includes("exportRespectGitignore で無効化"));
  });
});

suite("repomixExporter: 未解決項目の扱い", () => {
  test("missing / 未解決式は内容なしでスキップ一覧と印付きツリーに載る", () => {
    const projectPath = path.join(FIXTURES_ROOT, "edge-cases", "EdgeCases.vbproj");
    const parseResult = parseVbproj(
      fs.readFileSync(projectPath, "utf8"),
      projectPath,
      { fileExists: () => false },
    );
    const result = buildRepomixOutput(
      "EdgeCases.vbproj",
      [{ label: "EdgeCases", parseResult }],
      fakeDeps,
      { includeSensitive: false, maskCredentials: false },
    );
    assert.strictEqual(result.fileCount, 0);
    assert.ok(result.content.includes("Missing.vb [ファイルなし]"));
    assert.ok(result.content.includes("Helper.vb [未解決式]"));
    assert.ok(
      result.skipped.some(
        (s) => s.path === "EdgeCases\\Missing.vb" && s.reason.includes("存在しません"),
      ),
    );
  });
});

suite("repomixExporter: ui_summary(Designer 要約)", () => {
  /** Designer.vb だけ fixture の実内容を返し、他は fake を返す reader */
  const designerAwareDeps = {
    readTextFile: (absolutePath: string): string | undefined =>
      /\.designer\.vb$/i.test(absolutePath)
        ? fs.readFileSync(absolutePath, "utf8")
        : fakeDeps.readTextFile(absolutePath),
  };
  const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];

  test("既定で Designer.vb は <ui_summary> として要約される", () => {
    const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
      includeSensitive: false,
      maskCredentials: false,
    });
    assert.strictEqual(result.uiSummaryCount, 1);
    assert.ok(
      result.content.includes(
        '<ui_summary path="Basic\\Forms\\OrderForm.Designer.vb" form="OrderForm">',
      ),
    );
    assert.ok(result.content.includes('- btnSave: Button — Text "保存"'));
    assert.ok(result.content.includes('フォームタイトル: "受注入力"'));
    // 原文(座標行)は含まれない
    assert.ok(!result.content.includes("System.Drawing.Point"));
    assert.ok(
      result.skipped.some(
        (s) =>
          s.path === "Basic\\Forms\\OrderForm.Designer.vb" &&
          s.reason.includes("要約済み"),
      ),
    );
  });

  test("uiSummary: false で従来どおり要約なしのスキップになる", () => {
    const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
      includeSensitive: false,
      maskCredentials: false,
      uiSummary: false,
    });
    assert.strictEqual(result.uiSummaryCount, 0);
    assert.ok(!result.content.includes("<ui_summary path="));
  });

  test("includeSensitive: true では原文が含まれ要約は出さない", () => {
    const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
      includeSensitive: true,
      maskCredentials: false,
    });
    assert.strictEqual(result.uiSummaryCount, 0);
    assert.ok(!result.content.includes("<ui_summary path="));
    assert.ok(
      result.content.includes('<file path="Basic\\Forms\\OrderForm.Designer.vb">'),
    );
  });

  test("述語で含めなかった Designer.vb は <ui_summary> として要約される", () => {
    const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
      includeSensitive: (logicalPath) =>
        logicalPath === "My Project\\Application.Designer.vb",
      maskCredentials: false,
    });
    // 含めた側は原文、含めなかった側は要約に回る
    assert.ok(
      result.content.includes(
        '<file path="Basic\\My Project\\Application.Designer.vb">',
      ),
    );
    assert.strictEqual(result.uiSummaryCount, 1);
    assert.ok(
      result.content.includes(
        '<ui_summary path="Basic\\Forms\\OrderForm.Designer.vb" form="OrderForm">',
      ),
    );
  });

  test(".gitignore 対象の Designer.vb は要約もしない", () => {
    const result = buildRepomixOutput(
      "Basic.vbproj",
      sources,
      {
        readTextFile: designerAwareDeps.readTextFile,
        ignoreReasonFor: (absolutePath) =>
          /\.designer\.vb$/i.test(absolutePath) ? "/base/.gitignore" : undefined,
      },
      { includeSensitive: false, maskCredentials: false },
    );
    assert.strictEqual(result.uiSummaryCount, 0);
    assert.ok(!result.content.includes("<ui_summary path="));
  });

  test("要約前の Designer ソースにもマスクが適用される", () => {
    const designerWithSecret = [
      "Partial Class LoginForm",
      "    Friend WithEvents txtPassword As System.Windows.Forms.TextBox",
      "    Private Sub InitializeComponent()",
      '        Me.txtPassword.Text = "admin123"',
      "        Me.Controls.Add(Me.txtPassword)",
      '        Me.Text = "ログイン"',
      "    End Sub",
      "End Class",
    ].join("\n");
    const result = buildRepomixOutput(
      "Basic.vbproj",
      sources,
      {
        readTextFile: (absolutePath) =>
          /\.designer\.vb$/i.test(absolutePath)
            ? designerWithSecret
            : fakeDeps.readTextFile(absolutePath),
      },
      { includeSensitive: false, maskCredentials: true },
    );
    assert.ok(result.uiSummaryCount >= 1);
    assert.ok(!result.content.includes("admin123"));
    assert.ok(result.content.includes('Text "[MASKED]"'));
    assert.ok(
      result.maskedFiles.some((f) => f.path.includes("<ui_summary>")),
    );
  });

  test("コントロールを抽出できない Designer.vb は通常スキップ扱い", () => {
    const result = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
      includeSensitive: false,
      maskCredentials: false,
    });
    assert.strictEqual(result.uiSummaryCount, 0);
    assert.ok(!result.content.includes("<ui_summary path="));
    assert.ok(
      result.skipped.some(
        (s) =>
          s.path === "Basic\\Forms\\OrderForm.Designer.vb" &&
          s.reason.includes("Designer"),
      ),
    );
  });
});

suite("repomixExporter: decodeSourceBuffer", () => {
  test("CP932(Shift_JIS)を自動判定して復元する", () => {
    const original = "' 日本語コメント付きの VB コード\r\nModule M\r\nEnd Module";
    const buffer = Buffer.from(sjisEncode(original).bytes);
    assert.strictEqual(decodeSourceBuffer(buffer), original);
  });

  test("UTF-8 BOM 付きは BOM を除去して読む", () => {
    const buffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("Module M", "utf8"),
    ]);
    assert.strictEqual(decodeSourceBuffer(buffer), "Module M");
  });

  test("BOM なし UTF-8 はそのまま読む", () => {
    const original = "' 日本語も UTF-8 のまま";
    assert.strictEqual(decodeSourceBuffer(Buffer.from(original, "utf8")), original);
  });

  test("UTF-16 LE(BOM 付き)も読める", () => {
    const original = "Module ユニコード";
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original, "utf16le")]);
    assert.strictEqual(decodeSourceBuffer(buffer), original);
  });
});

suite("repomixExporter: SDK スタイルの既定グロブ展開の宣言", () => {
  function parseSdkFixture(relative: string): VbprojParseResult {
    const projectPath = path.join(FIXTURES_ROOT, "sdk-style", ...relative.split("/"));
    const listFilesRecursive = (dir: string): string[] => {
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
    };
    return parseVbproj(fs.readFileSync(projectPath, "utf8"), projectPath, {
      fileExists: (p) => fs.existsSync(p),
      listFilesRecursive,
    });
  }

  test("展開したプロジェクトがあれば <file_summary> に展開の宣言が入り、展開ファイルが出力される", () => {
    const result = buildRepomixOutput(
      "SdkStyle.sln",
      [
        { label: "SdkBasic", parseResult: parseSdkFixture("SdkBasic/SdkBasic.vbproj") },
        { label: "SdkNoDefault", parseResult: parseSdkFixture("SdkNoDefault/SdkNoDefault.vbproj") },
      ],
      fakeDeps,
      { includeSensitive: false, maskCredentials: false },
    );
    assert.ok(
      result.content.includes(
        "- SDK スタイルのプロジェクト(SdkBasic)は Compile を明示列挙しないため、既定の Compile グロブ(**/*.vb)を展開した",
      ),
    );
    assert.ok(result.content.includes("MSBuild の完全評価ではない"));
    assert.ok(result.content.includes('<file path="SdkBasic\\Api\\Service.vb">'));
    assert.ok(result.content.includes('<file path="SdkBasic\\Shared\\Helper.vb">'));
    assert.ok(result.content.includes('<file path="SdkNoDefault\\Only.vb">'));
    assert.ok(!result.content.includes("Excluded"));
    assert.ok(!result.content.includes("Ignored.vb"));
    assert.ok(!result.content.includes("BinGen"));
  });

  test("旧スタイルだけなら宣言は入らない(従来出力のまま)", () => {
    const result = buildRepomixOutput(
      "Basic.vbproj",
      [{ label: "Basic", parseResult: parseBasic() }],
      fakeDeps,
      { includeSensitive: false, maskCredentials: false },
    );
    assert.ok(!result.content.includes("SDK スタイルのプロジェクト"));
  });
});

// ---------------------------------------------------------------------------
// フェーズ 3: 物理パス化・extraRoots・生成コード除外・<contract_summary>
// ---------------------------------------------------------------------------

function listFilesRecursiveReal(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursiveReal(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

const realDeps = {
  readTextFile: (absolutePath: string): string | undefined => {
    try {
      return fs.readFileSync(absolutePath, "utf8");
    } catch {
      return undefined;
    }
  },
  listFilesRecursive: listFilesRecursiveReal,
};

function parseReal(relativeVbproj: string): VbprojParseResult {
  const projectPath = path.join(FIXTURES_ROOT, ...relativeVbproj.split("/"));
  return parseVbproj(fs.readFileSync(projectPath, "utf8"), projectPath, {
    fileExists: (p) => fs.existsSync(p),
    listFilesRecursive: listFilesRecursiveReal,
  });
}

suite("repomixExporter: 物理パス化(hybrid fixture)", () => {
  const rootDir = path.join(FIXTURES_ROOT, "hybrid");
  const sources: RepomixSource[] = [
    { label: "App", parseResult: parseReal("hybrid/App/App.vbproj") },
    { label: "App.Contract", parseResult: parseReal("hybrid/dotnet/App.Contract/App.Contract.vbproj") },
  ];
  const extraRoots = [
    { path: "apps/web", kind: "web", include: ["**/*.{ts,tsx,js,jsx,css,json,html}"], exclude: [] },
    { path: "contract", kind: "contract", include: ["contract.ts", "package.json"], exclude: [] },
  ];
  const generatedDirs = ["dotnet/App.Contract/Generated", "apps/web/src/generated"];
  const result = buildRepomixOutput("Hybrid.sln", sources, realDeps, {
    includeSensitive: false,
    maskCredentials: true,
    rootDir,
    extraRoots,
    contractSchema: "contract/contract.schema.json",
    contractFile: "contract/contract.ts",
    generatedDirs,
  });

  test("path 属性はルート相対の物理パス(/ 区切り)。プロジェクト名の接頭辞は付かない", () => {
    assert.ok(result.content.includes('<file path="App/Forms/MainForm.vb">'));
    assert.ok(!result.content.includes('path="App\\Forms'));
  });

  test("Link(論理 ≠ 物理)は logical / project 属性を持ち、ツリーに → 物理パスを併記", () => {
    assert.ok(
      result.content.includes(
        '<file path="Shared/Util.vb" project="App" logical="Common\\Util.vb">',
      ),
    );
    assert.ok(result.content.includes("    Util.vb → Shared/Util.vb"));
    assert.ok(!result.content.includes("MainForm.vb →"));
  });

  test("プロジェクト名 ≠ 物理フォルダ名(dotnet/App.Contract)も物理パスになる", () => {
    assert.ok(
      result.content.includes(
        '<file path="dotnet/App.Contract/PartsService.vb" project="App.Contract" logical="PartsService.vb">',
      ),
    );
  });

  test("file_summary に path 規則と新規ファイルの置き場所の規則が書かれる", () => {
    assert.ok(result.content.includes("ルート「hybrid」からの相対物理パス(/ 区切り)"));
    assert.ok(result.content.includes("changes.md のパスはこの path をそのまま使うこと"));
    assert.ok(result.content.includes("<directory_structure> は Visual Studio の論理構成"));
  });

  test("extraRoots のファイルは root 属性付きで含まれ、ツリーに [kind] path/ でグループ表示", () => {
    assert.ok(result.content.includes('<file path="apps/web/src/App.tsx" root="web">'));
    assert.ok(result.content.includes('<file path="contract/contract.ts" root="contract">'));
    assert.ok(result.content.includes("[web] apps/web/\n  src/\n"));
    assert.ok(result.content.includes("[contract] contract/\n  contract.ts\n  package.json"));
    assert.strictEqual(result.extraRootFileCount, 8);
    assert.strictEqual(result.fileCount, 3 + 8);
    // extraRoots のファイルも filePaths に入る(自動テストの有無の判定に使う)
    assert.strictEqual(result.filePaths.length, 3 + 8);
    assert.ok(result.filePaths.includes("App/Forms/MainForm.vb"));
    assert.ok(result.filePaths.includes("apps/web/src/App.tsx"));
    assert.ok(result.filePaths.includes("contract/contract.ts"));
    assert.ok(!result.filePaths.includes("contract/contract.schema.json"), "要約済みの契約スキーマは <file> に出ないので含まない");
  });

  test(".env と include 対象外(README.md)は含まれない", () => {
    assert.ok(!result.content.includes('path="apps/web/.env"'));
    assert.ok(!result.content.includes("dummy-secret-for-fixture"));
    assert.ok(!result.content.includes("apps/web/README.md"));
  });

  test("web 側にも認証情報マスクが効く(値だけを置換し、代入の形は壊さない)", () => {
    assert.ok(result.content.includes('const API_KEY = "[MASKED]";'));
    assert.ok(!result.content.includes("Zq7Vx2Lm9Rt4"));
    assert.ok(result.maskedFiles.some((f) => f.path === "apps/web/src/api.ts"));
  });

  test("generatedDirs 配下は VB 側・web 側とも除外され、理由が明記される", () => {
    assert.ok(!result.content.includes('path="dotnet/App.Contract/Generated/Contract.g.vb"'));
    assert.ok(!result.content.includes('path="apps/web/src/generated/contract.ts"'));
    assert.ok(
      result.skipped.some(
        (s) =>
          s.path === "dotnet/App.Contract/Generated/Contract.g.vb" &&
          s.reason.includes("生成コード") &&
          s.reason.includes("--include-generated"),
      ),
    );
    assert.ok(result.skipped.some((s) => s.path === "apps/web/src/generated/contract.ts"));
  });

  test("<contract_summary> が契約ルートの直後に置かれ、内容が要約されている", () => {
    assert.ok(result.contractSummaryIncluded);
    const contractIndex = result.content.indexOf('<file path="contract/package.json" root="contract">');
    const summaryIndex = result.content.indexOf('<contract_summary path="contract/contract.schema.json">');
    assert.ok(contractIndex >= 0 && summaryIndex > contractIndex);
    assert.ok(
      result.content.includes(
        "契約から生成された API の要約(生成コード dotnet/App.Contract/Generated/、apps/web/src/generated/ は除外。契約の正本は contract/contract.ts):",
      ),
    );
    assert.ok(
      result.content.includes(
        "- parts.search(input: { keyword: string; limit?: integer }) -> { items: Part[] }",
      ),
    );
    assert.ok(result.content.includes("</contract_summary>\n</files>"));
  });

  test("includeGenerated で生成コードの原文が含まれる", () => {
    const withGenerated = buildRepomixOutput("Hybrid.sln", sources, realDeps, {
      includeSensitive: false,
      maskCredentials: false,
      rootDir,
      extraRoots,
      generatedDirs,
      includeGenerated: true,
    });
    assert.ok(
      withGenerated.content.includes(
        '<file path="dotnet/App.Contract/Generated/Contract.g.vb" project="App.Contract" logical="Generated\\Contract.g.vb">',
      ),
    );
    assert.ok(withGenerated.content.includes('<file path="apps/web/src/generated/contract.ts" root="web">'));
    assert.ok(withGenerated.content.includes("の原文を含む(オプション --include-generated)"));
  });

  test("契約スキーマが未知の形式なら要約せず、理由を skipped に書いて続行する", () => {
    const deps = {
      ...realDeps,
      readTextFile: (p: string) =>
        p.endsWith("contract.schema.json")
          ? JSON.stringify({ contractVersion: 99 })
          : realDeps.readTextFile(p),
    };
    const unknown = buildRepomixOutput("Hybrid.sln", sources, deps, {
      includeSensitive: false,
      maskCredentials: false,
      rootDir,
      extraRoots,
      contractSchema: "contract/contract.schema.json",
    });
    assert.ok(!unknown.contractSummaryIncluded);
    assert.ok(!unknown.content.includes("<contract_summary"));
    assert.ok(
      unknown.skipped.some(
        (s) => s.path === "contract/contract.schema.json" && s.reason.includes("contractVersion: 99"),
      ),
    );
    assert.ok(unknown.content.includes('<file path="contract/contract.ts" root="contract">'));
  });

  test("rootDir なし(--legacy-paths)なら従来の表記になり、extraRoots は警告して無視", () => {
    const legacy = buildRepomixOutput("Hybrid.sln", sources, realDeps, {
      includeSensitive: false,
      maskCredentials: false,
      extraRoots,
    });
    assert.ok(legacy.content.includes('<file path="App\\Forms\\MainForm.vb">'));
    assert.ok(legacy.content.includes('<file path="App\\Common\\Util.vb">'));
    assert.ok(!legacy.content.includes('root="web"'));
    assert.ok(legacy.content.includes("パスは物理配置ではなく Visual Studio の論理構成"));
    assert.ok(legacy.diagnostics.some((d) => d.message.includes("--legacy-paths")));
  });
});

suite("repomixExporter: ルート外のファイル(適用ツールの範囲外)", () => {
  // solution fixture の各プロジェクトは ..\basic 等、.sln のディレクトリの外にある
  const rootDir = path.join(FIXTURES_ROOT, "solution");
  const result = buildRepomixOutput(
    "Sample.sln",
    [{ label: "Basic", parseResult: parseReal("basic/Basic.vbproj") }],
    realDeps,
    { includeSensitive: false, maskCredentials: false, rootDir },
  );

  test("path は論理パス(プロジェクト名/論理パス)のまま、physical / outside_root 属性で物理パスを示す", () => {
    const physical = path.join(FIXTURES_ROOT, "basic", "Module1.vb").split(path.sep).join("/");
    assert.ok(
      result.content.includes(
        `<file path="Basic/Module1.vb" project="Basic" physical="${physical}" outside_root="true">`,
      ),
    );
  });

  test("file_summary にルート外のファイル一覧が明記される", () => {
    assert.ok(result.content.includes("- ルート外のファイル(適用ツールの範囲外。物理パスは physical 属性): "));
    assert.ok(result.content.includes("Basic/Module1.vb"));
  });

  test("ツリーには → 物理パス(ルート外) を併記する", () => {
    assert.ok(/Module1\.vb → .*Module1\.vb\(ルート外\)/.test(result.content));
  });
});

suite("repomixExporter: relativeWithinRoot", () => {
  test("配下なら / 区切りの相対パス、外なら undefined", () => {
    const root = path.resolve("/work/repo");
    assert.strictEqual(relativeWithinRoot(root, path.join(root, "a", "b.vb")), "a/b.vb");
    assert.strictEqual(relativeWithinRoot(root, path.resolve("/work/other/b.vb")), undefined);
    assert.strictEqual(relativeWithinRoot(root, root), undefined);
  });

  test("Windows のドライブ絶対パス(別ドライブの Link)は実行環境によらず外と判定する", () => {
    assert.strictEqual(relativeWithinRoot(path.resolve("/work/repo"), "D:\\Shared\\External.vb"), undefined);
    assert.strictEqual(relativeWithinRoot(path.resolve("/work/repo"), "\\\\server\\share\\x.vb"), undefined);
  });
});

suite("repomixExporter: ルートが .sln より上にある構成(nested-root fixture)", () => {
  const rootDir = path.join(FIXTURES_ROOT, "nested-root");
  const projectPath = path.join(rootDir, "dotnet", "App", "App.vbproj");
  const parseResult = parseVbproj(fs.readFileSync(projectPath, "utf8"), projectPath, {
    fileExists: (p) => fs.existsSync(p),
  });
  const listFilesRecursive = (dir: string): string[] | undefined => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
    };
    walk(dir);
    return out.sort();
  };
  const result = buildRepomixOutput(
    "App.sln",
    [{ label: "App", parseResult }],
    {
      readTextFile: (p) => fs.readFileSync(p, "utf8"),
      listFilesRecursive,
    },
    {
      includeSensitive: false,
      maskCredentials: false,
      rootDir,
      extraRoots: [
        { path: "web", kind: "web", include: ["**/*.ts"], exclude: [] },
        { path: "e2e", kind: "test", include: ["**/*.ts"], exclude: [] },
      ],
    },
  );

  test("VB の物理パスはルート相対になり、dotnet/ の接頭辞が付く", () => {
    assert.ok(result.content.includes('<file path="dotnet/App/Module1.vb"'), result.content);
    assert.ok(!result.content.includes("outside_root"), "ルート外扱いになっている");
  });

  test("ルート直下の web / e2e が extraRoots として同じパックに入る", () => {
    assert.ok(result.content.includes('<file path="web/src/main.ts" root="web">'));
    assert.ok(result.content.includes('<file path="e2e/screen/main.spec.ts" root="test">'));
    assert.ok(result.filePaths.includes("e2e/screen/main.spec.ts"));
  });
});

// ---------------------------------------------------------------------------
// v0.17.0: generic 構成(.sln / .vbproj なし。extraRoots のみ)
// ---------------------------------------------------------------------------

suite("repomixExporter: generic 構成(layout: generic、hybrid fixture の web 側のみ)", () => {
  const rootDir = path.join(FIXTURES_ROOT, "hybrid");
  const extraRoots = [
    { path: "apps/web", kind: "src", include: ["**/*.{ts,tsx,js,jsx,css,json,html}"], exclude: [] },
  ];
  const result = buildRepomixOutput("hybrid", [], realDeps, {
    includeSensitive: false,
    maskCredentials: true,
    rootDir,
    extraRoots,
    layout: "generic",
  });

  test("ソースが空でも extraRoots のファイルだけでパックになる", () => {
    assert.ok(result.fileCount > 0);
    assert.strictEqual(result.fileCount, result.extraRootFileCount);
    assert.ok(result.content.includes('<file path="apps/web/src/App.tsx" root="src">'));
    assert.ok(result.content.includes("[src] apps/web/\n  src/\n"));
  });

  test("ヘッダーは extraRoots に基づく旨を述べ、Visual Studio / Designer / .resx / Link の記述を持たない", () => {
    assert.ok(result.content.includes("「hybrid」の slnmix.config.json(extraRoots)に宣言されたディレクトリに基づき"));
    assert.ok(result.content.includes(".sln / .vbproj の論理構成は使っていない"));
    assert.ok(result.content.includes("ルート「hybrid」からの相対物理パス(/ 区切り)"));
    assert.ok(result.content.includes("新規ファイルも同じ規則で書くこと"));
    assert.ok(result.content.includes("宣言されていないディレクトリは含まれない"));
    for (const phrase of [
      "Visual Studio",
      "Designer",
      "EmbeddedResource",
      "Link",
      "置きたいプロジェクトの物理フォルダ配下",
      ".vbproj に乗らない",
      "VB 側と同様",
    ]) {
      assert.ok(!result.content.includes(phrase), `${phrase} が残っています`);
    }
  });

  test("認証情報マスク・.gitignore・skipped の共通の注記は残る", () => {
    assert.ok(result.content.includes("[MASKED] に自動置換済み"));
    assert.ok(result.content.includes("<skipped_files>"));
    assert.ok(result.content.includes('const API_KEY = "[MASKED]";'));
  });

  test("layout 省略(solution)の出力は従来と同一", () => {
    const base = buildRepomixOutput("Hybrid.sln", [], realDeps, {
      includeSensitive: false,
      maskCredentials: true,
      rootDir,
      extraRoots,
    });
    const explicit = buildRepomixOutput("Hybrid.sln", [], realDeps, {
      includeSensitive: false,
      maskCredentials: true,
      rootDir,
      extraRoots,
      layout: "solution",
    });
    assert.strictEqual(base.content, explicit.content);
    assert.ok(base.content.includes("論理構成(.sln / .vbproj)に基づき"));
    assert.ok(base.content.includes("Designer 関連ファイルの原文は含まれない"));
  });
});
