/**
 * tazuna init — プロジェクト初回セットアップ (§4.6、設計書 §20・§25)。
 * 旧 slnmix init (構成の判定・docs/・.gitignore の生成物) と旧 petari init (.petari/config.json・
 * .gitignore の .petari/) を 1 つにしたもの。対話なしで、既存のファイルは変えない (冪等)。
 * 規約文は内蔵なので protocol.md は書き出さない。repomix.config.json も作らない
 * (tazuna pack が本家 repomix の代わりになる)。
 * --yes / --no-repomix は受け付けて無視する (旧 slnmix init が `--yes --no-repomix` で呼んでいたため)。
 */
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { initProject } from "../pack/initProject.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";
import {
  FS_DEPS,
  isDirectoryPath,
  isFilePath,
  listDirectoryNames,
  readSourceTextFile,
} from "./pack-io.ts";

export async function initCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      // 互換のため受け付けて無視する
      yes: { type: "boolean", short: "y", default: false },
      "no-repomix": { type: "boolean", default: false },
    },
  });
  const root = findProjectRoot(process.cwd(), values.root);
  const result = initProject(root, {
    isDirectory: isDirectoryPath,
    isFile: isFilePath,
    exists: (p) => fs.existsSync(p),
    listFileNames: FS_DEPS.listFileNames,
    listDirectoryNames,
    readTextFile: readSourceTextFile,
    writeTextFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    appendTextFile: (p, content) => fs.appendFileSync(p, content, "utf8"),
    makeDirectory: (p) => fs.mkdirSync(p, { recursive: true }),
    // エラーと警告は標準エラーへ
    log: (line) => (/^\s*\[(error|warning)\]/.test(line) ? err(line) : out(line)),
  });
  return result.exitCode;
}
