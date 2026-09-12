/**
 * 新規ファイルの形式推定に使う手本の収集 (設計書 §11.2)。ファイル I/O のみ。
 * 多数決と既定の決定は core/new-file-style.ts。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeFile } from "../core/encoding.ts";
import type { StyleSample, StyleSampleGroup } from "../core/new-file-style.ts";

/** 1 ディレクトリで読む手本の上限と 1 ファイルの上限 (I/O を抑える) */
const MAX_FILES_PER_DIR = 100;
const MAX_FILE_BYTES = 1024 * 1024;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function sampleOf(absPath: string): StyleSample | null {
  let bytes: Uint8Array;
  try {
    if (statSync(absPath).size > MAX_FILE_BYTES) return null;
    bytes = new Uint8Array(readFileSync(absPath));
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.includes(0)) return null; // 空 / バイナリは手本にしない
  try {
    const doc = decodeFile(bytes);
    return { encoding: doc.encoding, bom: doc.hasBom, eol: doc.eol };
  } catch {
    return null; // UTF-8 でも Shift_JIS でもないものは対象外
  }
}

function collectDir(absDir: string, dir: string, ext: string): StyleSampleGroup {
  const group: StyleSampleGroup = { dir, sameExt: [], others: [] };
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return group; // 未作成ディレクトリ (create 先)
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_FILES_PER_DIR);
  for (const name of files) {
    const s = sampleOf(join(absDir, name));
    if (s === null) continue;
    if (extensionOf(name) === ext) group.sameExt.push(s);
    else group.others.push(s);
  }
  return group;
}

/**
 * ルート相対パス path の作成先ディレクトリからルートまで、各ディレクトリの手本を近い順に集める。
 * 手本が見つかったディレクトリで打ち切る (core 側は最初の非空グループを採用する)。
 */
export function collectStyleSampleGroups(root: string, path: string): StyleSampleGroup[] {
  const ext = extensionOf(path.slice(path.lastIndexOf("/") + 1));
  const groups: StyleSampleGroup[] = [];
  let dir = dirname(path);
  if (dir === ".") dir = "";
  for (;;) {
    const group = collectDir(dir === "" ? root : join(root, dir), dir === "" ? "." : dir, ext);
    groups.push(group);
    if (group.sameExt.length > 0 || group.others.length > 0) break;
    if (dir === "") break;
    const parent = dirname(dir);
    dir = parent === "." ? "" : parent;
  }
  return groups;
}
