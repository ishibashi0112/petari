import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { findRoot } from "../pack/rootResolver.ts";

/**
 * プロジェクトルートの特定 (§9、設計書 §25.3-2)。--root で明示上書き。
 * なければカレントから上に向かって、最初の設定ファイル (petari.config.json / slnmix.config.json。
 * .git より上には行かない) > 最初の .git > カレント。パック (petari pack) と同じ決め方
 * (src/pack/rootResolver.ts) で、パックの <file path> と changes.md のパスの基準を揃える。
 * ネスト構成 (メニュー単位の Git リポジトリ) では実行場所のリポジトリがルートになる。
 */
export function findProjectRoot(cwd: string, override?: string): string {
  if (override !== undefined) return resolve(cwd, override);
  return findRoot(resolve(cwd), {
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    exists: (p) => existsSync(p),
  }).rootDir;
}
