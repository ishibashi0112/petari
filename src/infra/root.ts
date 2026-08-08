import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * プロジェクトルートの特定 (§9)。
 * カレントから上方向に最も近い .git を探索。なければカレント。--root で明示上書き。
 * ネスト構成 (メニュー単位の Git リポジトリ) では実行場所のリポジトリがルートになる。
 */
export function findProjectRoot(cwd: string, override?: string): string {
  if (override !== undefined) return resolve(cwd, override);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
