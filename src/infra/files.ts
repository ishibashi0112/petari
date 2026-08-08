import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, sep } from "node:path";
import type { FileState } from "../core/applier.ts";

/**
 * absPath の「存在する最も近い祖先ディレクトリ」の実体 (realpath) が
 * root 配下にあるかを検証する (§9 の defense-in-depth)。
 * プロジェクト内の symlink ディレクトリを経由したルート外への書き込みを防ぐ。
 */
export function isInsideRoot(root: string, absPath: string): boolean {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return false;
  }
  let dir = dirname(absPath);
  for (;;) {
    try {
      const real = realpathSync(dir);
      return real === rootReal || real.startsWith(rootReal + sep);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/** 適用対象ファイルの状態を読む (シンボリックリンク検出は lstat・§9) */
export function readFileState(absPath: string): FileState {
  let symlink = false;
  let exists = false;
  try {
    const st = lstatSync(absPath);
    symlink = st.isSymbolicLink();
    exists = true;
  } catch {
    return { exists: false, symlink: false, bytes: null };
  }
  if (symlink) return { exists, symlink, bytes: null };
  return { exists, symlink, bytes: new Uint8Array(readFileSync(absPath)) };
}

export function writeBytes(absPath: string, bytes: Uint8Array): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);
}

export function deleteFile(absPath: string): void {
  unlinkSync(absPath);
}

export function fileExists(absPath: string): boolean {
  return existsSync(absPath);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
