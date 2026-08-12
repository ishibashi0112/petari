/**
 * monaco-editor のビルド時同梱 (vendoring)。
 * node_modules/monaco-editor/min/vs を vendor/monaco/vs へ丸ごとコピーする
 * (0.5x 系の min ビルドはハッシュ付きチャンクが相互参照するため部分コピーは不可)。
 * ライセンスと ThirdPartyNotices も同梱する。
 * 実行: pnpm gen:monaco (pnpm build にも含まれる)。vendor/ は .gitignore 対象で、
 * npm パッケージには package.json の files で含める。
 */
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// monaco-editor の exports は package.json を公開していないため node_modules 直下を辿る
// (pnpm の symlink を realpath で解決)
const pkgDir = realpathSync(join(rootDir, "node_modules", "monaco-editor"));
const dest = join(rootDir, "vendor", "monaco");

const version = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(pkgDir, "min", "vs"), join(dest, "vs"), { recursive: true });
cpSync(join(pkgDir, "LICENSE"), join(dest, "LICENSE.txt"));
cpSync(join(pkgDir, "ThirdPartyNotices.txt"), join(dest, "ThirdPartyNotices.txt"));

function dirSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

console.log(`monaco-editor v${version} を同梱しました: ${dest}`);
console.log(`  サイズ: ${(dirSize(dest) / 1024 / 1024).toFixed(1)} MB`);
