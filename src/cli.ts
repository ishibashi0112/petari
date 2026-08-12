#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { err as errLine } from "./infra/term.ts";

const SUBCOMMANDS = ["undo", "show", "list", "protocol", "init"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number] | "apply";

function version(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
}

const HELP = `petari — paste AI chat patches onto your codebase

Usage:
  petari [path]         changes.md を適用 (省略時: Downloads から自動検出)
  petari undo [ID]      履歴を巻き戻す (ID 省略時: 直近)
  petari show [ID]      履歴の差分を表示 (VS Code / ブラウザ)。--edit で手修正
  petari list           履歴の一覧を表示
  petari protocol       AI への規約文を標準出力に出す
  petari init           プロジェクト初回セットアップ

Options:
  -h, --help            ヘルプを表示
  -v, --version         バージョンを表示
`;

export async function main(argv: string[]): Promise<number> {
  // pnpm run は "--" をそのまま渡してくる (npm と異なり消費しない) ため先頭の区切りを除く
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
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
    default:
      process.stderr.write(`petari: "${sub}" は未実装です\n`);
      return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly || process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // エラーメッセージには changes.md 由来の文字が混入し得るためサニタイズして出力
      errLine(`petari: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
