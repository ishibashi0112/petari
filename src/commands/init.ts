/**
 * petari init — プロジェクト初回セットアップの一括実行 (§4.6)。
 * 対話形式 (--yes で全提案に自動同意)。既存ファイルは上書きせず確認する。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_TEXT } from "../assets/protocol.ts";
import { confirm } from "../infra/prompt.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";

const CONFIG_TEMPLATE = `{
  "downloadsDir": null,
  "newFile": { "encoding": "utf8", "eol": "lf" },
  "historyLimit": null,
  "vscodeCommand": "code",
  "clipReportOnFailure": true
}
`;

export async function initCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  const root = findProjectRoot(process.cwd(), values.root);
  const ask = async (question: string): Promise<boolean> =>
    values.yes ? true : confirm(question);

  out(`プロジェクトルート: ${root}`);

  // 1. .petari/config.json の雛形 (§4.6-1)
  const configPath = join(root, ".petari", "config.json");
  if (existsSync(configPath)) {
    out(`1. ${configPath} は既にあります (変更しません)`);
  } else if (await ask("1. .petari/config.json の雛形を作成しますか?")) {
    mkdirSync(join(root, ".petari"), { recursive: true });
    writeFileSync(configPath, CONFIG_TEMPLATE, "utf8");
    out(`   作成しました: ${configPath}`);
  }

  // 2. protocol.md (§4.6-2)
  const protocolPath = join(root, "protocol.md");
  if (existsSync(protocolPath)) {
    const current = readFileSync(protocolPath, "utf8");
    if (current === PROTOCOL_TEXT) {
      out(`2. ${protocolPath} は最新です`);
    } else if (await ask("2. protocol.md の内容が規約文と異なります。更新しますか?")) {
      writeFileSync(protocolPath, PROTOCOL_TEXT, "utf8");
      out(`   更新しました: ${protocolPath}`);
    }
  } else if (await ask("2. protocol.md (AI への規約文) をプロジェクト直下に作成しますか?")) {
    writeFileSync(protocolPath, PROTOCOL_TEXT, "utf8");
    out(`   作成しました: ${protocolPath}`);
  }

  // 3. repomix 連携 (§4.6-3)
  const repomixPath = join(root, "repomix.config.json");
  if (existsSync(repomixPath)) {
    let parsed: { output?: { instructionFilePath?: string } };
    try {
      parsed = JSON.parse(readFileSync(repomixPath, "utf8")) as typeof parsed;
    } catch {
      err(`3. ${repomixPath} を JSON として読めないためスキップします`);
      parsed = { output: { instructionFilePath: "(parse error)" } };
    }
    if (parsed.output?.instructionFilePath !== undefined) {
      out(`3. repomix.config.json は instructionFilePath 設定済みです (変更しません)`);
    } else if (
      await ask('3. repomix.config.json に output.instructionFilePath: "protocol.md" を追記しますか?')
    ) {
      parsed.output = { ...(parsed.output ?? {}), instructionFilePath: "protocol.md" };
      writeFileSync(repomixPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      out(`   追記しました: ${repomixPath}`);
    }
  } else if (
    await ask("3. repomix 連携用の repomix.config.json (最小構成) を作成しますか?")
  ) {
    writeFileSync(
      repomixPath,
      JSON.stringify({ output: { instructionFilePath: "protocol.md" } }, null, 2) + "\n",
      "utf8",
    );
    out(`   作成しました: ${repomixPath}`);
  }

  // 4. .gitignore に .petari/ (§4.6-4, §5)
  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    const lines = readFileSync(gitignorePath, "utf8").split(/\r?\n/);
    if (lines.some((l) => l.trim() === ".petari/" || l.trim() === ".petari")) {
      out("4. .gitignore は .petari/ を含んでいます");
    } else if (await ask("4. .gitignore に .petari/ を追記しますか?")) {
      const text = readFileSync(gitignorePath, "utf8");
      writeFileSync(gitignorePath, text + (text.endsWith("\n") || text === "" ? "" : "\n") + ".petari/\n", "utf8");
      out("   追記しました: .gitignore");
    }
  } else if (await ask("4. .gitignore を作成して .petari/ を追記しますか?")) {
    writeFileSync(gitignorePath, ".petari/\n", "utf8");
    out("   作成しました: .gitignore");
  }

  out("");
  out("セットアップ完了。repomix 実行で規約文入りのコンテキストが生成されます。");
  out("slnmix (v0.7.0+) は同じディレクトリの protocol.md を出力末尾に自動連結します。");
  return 0;
}
