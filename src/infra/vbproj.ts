/**
 * 最寄り .vbproj の探索 (設計書 §11.1)。ファイル I/O のみ。判定・挿入は core/vbproj.ts。
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type VbprojLookup =
  /** path はルート相対 (/ 区切り) */
  | { kind: "found"; path: string }
  | { kind: "none" }
  /** 同じディレクトリに複数あり、人が決める必要がある */
  | { kind: "multiple"; dir: string; names: string[] };

function listVbproj(absDir: string): string[] | null {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      // 書き込み対象になるため symlink は除外する (Dirent 判定・§9)
      .filter((e) => e.isFile() && /\.vbproj$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return null; // 未作成ディレクトリ (create 先) は手本なしとして上へ辿る
  }
}

/**
 * ルート相対ディレクトリ relDir から上へ辿り、プロジェクトルートまでの間で最寄りの .vbproj を探す。
 * ルートの外には出ない。
 */
export function findNearestVbproj(root: string, relDir: string): VbprojLookup {
  let dir = relDir === "." ? "" : relDir;
  for (;;) {
    const names = listVbproj(dir === "" ? root : join(root, dir));
    if (names !== null && names.length === 1) {
      return { kind: "found", path: dir === "" ? (names[0] as string) : `${dir}/${names[0] as string}` };
    }
    if (names !== null && names.length > 1) return { kind: "multiple", dir: dir === "" ? "." : dir, names };
    if (dir === "") return { kind: "none" };
    const parent = dirname(dir);
    dir = parent === "." ? "" : parent;
  }
}
