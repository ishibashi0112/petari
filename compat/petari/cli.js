#!/usr/bin/env node
/**
 * petari — tazuna を呼ぶだけの互換コマンド(0.15.0〜)。引数はそのまま、依存の tazuna の CLI を
 * 同じ node で起動する(配列引数・シェル非経由)。終了コードは tazuna のもの。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planForward } from "./forward.js";

/** @param {string} file */
function readPackageJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 依存の tazuna の CLI(dist/cli.js)の絶対パスと版 */
function locateTazuna() {
  const packageJsonPath = createRequire(import.meta.url).resolve("tazuna/package.json");
  const pkg = readPackageJson(packageJsonPath);
  const bin =
    typeof pkg.bin === "string" ? pkg.bin : typeof pkg.bin?.tazuna === "string" ? pkg.bin.tazuna : "dist/cli.js";
  return {
    cliPath: resolve(dirname(packageJsonPath), bin),
    version: typeof pkg.version === "string" ? pkg.version : "不明",
  };
}

/** @param {readonly string[]} argv */
function main(argv) {
  const plan = planForward(argv);
  let tazuna;
  try {
    tazuna = locateTazuna();
  } catch (error) {
    process.stderr.write(
      `[petari] 依存の tazuna が見つかりません(${error instanceof Error ? error.message : String(error)})。npx tazuna を使ってください。\n`,
    );
    return 1;
  }
  if (plan.kind === "version") {
    const own = readPackageJson(join(dirname(fileURLToPath(import.meta.url)), "package.json")).version;
    process.stdout.write(`${own}(tazuna ${tazuna.version} を呼びます)\n`);
    return 0;
  }
  process.stderr.write(plan.notice + "\n");
  // Ctrl+C は子(tazuna)にも届く。tazuna watch が適用の途中なら終わるまで待ってから抜けるよう、
  // こちらは子の終了を待つ(既定の動作のままだと先に終了して、子の出力がプロンプトの後に出る)
  process.on("SIGINT", () => {});
  const result = spawnSync(process.execPath, [tazuna.cliPath, ...plan.args], { stdio: "inherit" });
  if (result.error !== undefined) {
    process.stderr.write(`[petari] tazuna を起動できませんでした: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
