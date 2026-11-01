#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { TOOL_NAME } from "./brand.ts";
import { err as errLine } from "./infra/term.ts";

const SUBCOMMANDS = ["pack", "build", "undo", "show", "list", "protocol", "init", "watch"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number] | "apply";

function version(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
}

const T = TOOL_NAME;
const HELP = `${T} — AI チャットでの開発を、コードベースを渡す → 返答を当てる → ビルドする の流れで支える

Usage:
  ${T} init           プロジェクト初回セットアップ (リポジトリ直下で一回だけ。何度実行しても同じ結果)
  ${T} pack [入力]    コードベースを 1 ファイルにまとめ、チャットに貼るものをクリップボードへ
                        (${T} pack --help でオプション一覧)
  ${T} [path]         changes.md を適用 (省略時: Downloads から自動検出)
  ${T} watch          Downloads を見張り、届いた changes.md を確認なしで適用
                        (Ctrl+C で終了)
  ${T} undo [ID]      履歴を巻き戻す (ID 省略時: 直近)
  ${T} show [ID]      履歴の差分を表示 (VS Code / ブラウザ)。--edit で手修正 (VS Code)
  ${T} list           履歴の一覧を表示
  ${T} build [入力]   MSBuild でビルドし、失敗したらエラーと周辺のコードをクリップボードへ
  ${T} protocol       AI への規約文を標準出力に出す (パックには内蔵の規約文が自動で入る。
                        repomix など別の道具で使うとき用)

Options:
  -h, --help            ヘルプを表示
  -v, --version         バージョンを表示
`;

export async function main(argv: string[]): Promise<number> {
  // pnpm run は "--" をそのまま渡してくる (npm と異なり消費しない) ため先頭の区切りを除く
  if (argv[0] === "--") argv = argv.slice(1);
  // pack はそれぞれのオプション一覧を出す
  const ownHelp = argv[0] === "pack";
  if (!ownHelp && (argv.includes("-h") || argv.includes("--help"))) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!ownHelp && (argv.includes("-v") || argv.includes("--version"))) {
    process.stdout.write(version() + "\n");
    return 0;
  }

  const first = argv[0];
  const sub: Subcommand =
    first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)
      ? (first as Subcommand)
      : "apply";
  const rest = sub === "apply" ? argv : argv.slice(1);

  switch (sub) {
    case "pack": {
      const { packCommand } = await import("./commands/pack.ts");
      return packCommand(rest);
    }
    case "build": {
      const { buildCommand } = await import("./commands/build.ts");
      return buildCommand(rest);
    }
    case "apply": {
      const { applyCommand } = await import("./commands/apply.ts");
      return applyCommand(rest);
    }
    case "undo": {
      const { undoCommand } = await import("./commands/undo.ts");
      return undoCommand(rest);
    }
    case "show": {
      const { showCommand } = await import("./commands/show.ts");
      return showCommand(rest);
    }
    case "list": {
      const { listCommand } = await import("./commands/list.ts");
      return listCommand(rest);
    }
    case "protocol": {
      const { protocolCommand } = await import("./commands/protocol.ts");
      return protocolCommand(rest);
    }
    case "init": {
      const { initCommand } = await import("./commands/init.ts");
      return initCommand(rest);
    }
    case "watch": {
      const { watchCommand } = await import("./commands/watch.ts");
      return watchCommand(rest);
    }
    default:
      process.stderr.write(`${TOOL_NAME}: "${sub}" は未実装です\n`);
      return 1;
  }
}

// npx や npm の global インストールは macOS / Linux では node_modules/.bin の symlink 経由で
// 起動するため、argv[1] (symlink のパス) を実体に解決してから自分自身と比べる
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly() || process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // エラーメッセージには changes.md 由来の文字が混入し得るためサニタイズして出力
      errLine(`${TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
