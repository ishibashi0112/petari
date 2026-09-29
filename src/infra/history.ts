/**
 * 履歴ディレクトリ (.petari/history/) の読み書き (§5)。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "../types.ts";
import { sha256, writeBytes } from "./files.ts";

/** manifest 上の操作種別。"vbproj" は petari が自動で行った .vbproj への Compile 登録 (設計書 §11.1) */
export type ManifestOp = Operation | "vbproj";

export interface ManifestFileEntry {
  path: string;
  op: ManifestOp;
  /** この .vbproj に自動登録した .vb (ルート相対)。AI の変更対象と同じ .vbproj に登録した場合も付く */
  registered?: string[];
  /** このファイルに実際に書き込んだか (--partial でスキップされたら false) */
  applied: boolean;
  /** replace のブロック総数 (他の操作は 0) */
  blocks: number;
  /** 適用できたブロック数 */
  appliedBlocks: number;
  /** --partial でスキップしたブロック (index と理由) */
  skippedBlocks?: { index: number; reason: string }[];
  /** REPLACE が既に存在したためスキップしたブロック index (冪等性・成功扱い) */
  alreadyAppliedBlocks?: number[];
  /** ファイル全体が適用済みだったため書き込みをスキップした */
  alreadyApplied?: boolean;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface Manifest {
  id: string;
  appliedAt: string;
  success: boolean;
  partial: boolean;
  source: { type: "file" | "clipboard" | "downloads" | "project-root"; path?: string };
  /** changes.md の指紋 (core/fingerprint.ts)。同じ changes.md の再適用検出に使う (v0.10.0〜) */
  changesFingerprint?: string;
  /** petari undo で巻き戻した日時 (ISO 8601)。巻き戻し済みの履歴は再適用検出の対象外 */
  undoneAt?: string;
  files: ManifestFileEntry[];
}

export function petariDir(root: string): string {
  return join(root, ".petari");
}

export function historyRoot(root: string): string {
  return join(petariDir(root), "history");
}

/** 履歴 ID: YYYY-MM-DD_HHmm。同分内の衝突は連番サフィックス (§5) */
export function createHistoryId(root: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  let id = base;
  for (let n = 2; existsSync(join(historyRoot(root), id)); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/**
 * 履歴保存は 2 段階 (§4.1 手順 4)。
 * begin: 書き換え前に changes.md 原本と before/ を保存 (途中クラッシュでも復元材料が残る)
 * finish: 書き換え後に after/ と manifest.json を保存
 */
export function beginHistory(
  root: string,
  id: string,
  changesText: string,
  before: Map<string, Uint8Array | null>,
): string {
  const dir = join(historyRoot(root), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "changes.md"), changesText, "utf8");
  for (const [path, bytes] of before) {
    if (bytes !== null) writeBytes(join(dir, "before", path), bytes);
  }
  return dir;
}

export function finishHistory(
  root: string,
  id: string,
  manifest: Manifest,
  after: Map<string, Uint8Array | null>,
): void {
  const dir = join(historyRoot(root), id);
  for (const [path, bytes] of after) {
    if (bytes !== null) writeBytes(join(dir, "after", path), bytes);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function listHistoryIds(root: string): string[] {
  const dir = historyRoot(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** historyLimit を超えた古い履歴を削除する (§10)。null = 無制限 */
export function pruneHistory(root: string, limit: number | null): string[] {
  if (limit === null || limit < 1) return [];
  const ids = listHistoryIds(root);
  const excess = ids.slice(0, Math.max(0, ids.length - limit));
  for (const id of excess) {
    rmSync(join(historyRoot(root), id), { recursive: true, force: true });
  }
  return excess;
}

export function readManifest(root: string, id: string): Manifest | null {
  const p = join(historyRoot(root), id, "manifest.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

/** undo の完了を manifest に記録する (再適用検出で「巻き戻し済み」を区別するため) */
export function markUndone(root: string, id: string, at: Date): void {
  const p = join(historyRoot(root), id, "manifest.json");
  const manifest = JSON.parse(readFileSync(p, "utf8")) as Manifest;
  manifest.undoneAt = at.toISOString();
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/**
 * 同じ指紋の changes.md を適用した履歴 (巻き戻し済み・書き込みなしを除く) を新しい順に
 * 探し、最初に見つかった履歴 ID を返す。指紋を持たない旧形式の manifest は、保存済みの
 * changes.md 原本から fallback で算出する (null = 算出不能として対象外)。
 * manifest は非信頼入力のため、読めない・形が違うものは黙って対象外にする。
 */
export function findAppliedHistory(
  root: string,
  fingerprint: string,
  fallback: (changesText: string) => string | null,
): string | null {
  for (const id of listHistoryIds(root).reverse()) {
    let manifest: Manifest | null;
    try {
      manifest = readManifest(root, id);
    } catch {
      continue;
    }
    if (manifest === null || typeof manifest !== "object") continue;
    if (manifest.undoneAt !== undefined) continue;
    if (!Array.isArray(manifest.files) || !manifest.files.some((f) => f?.applied === true)) continue;
    let fp: string | null = null;
    if (typeof manifest.changesFingerprint === "string") {
      fp = manifest.changesFingerprint;
    } else {
      const p = join(historyRoot(root), id, "changes.md");
      try {
        fp = fallback(readFileSync(p, "utf8"));
      } catch {
        fp = null;
      }
    }
    if (fp === fingerprint) return id;
  }
  return null;
}

export { sha256 };
