/**
 * petari list — 履歴の一覧 (§4.4)。
 * ID・日時・概要 (CHANGES 先頭行)・対象ファイル数・成否と、履歴全体のサイズを表示する。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { historyRoot, listHistoryIds, readManifest } from "../infra/history.ts";
import { findProjectRoot } from "../infra/root.ts";
import { out } from "../infra/term.ts";

function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += statSync(p).size;
  }
  return total;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** changes.md の CHANGES 概要の先頭行 (## CHANGES の次の非空行) */
function summaryLine(historyDir: string): string {
  const p = join(historyDir, "changes.md");
  if (!existsSync(p)) return "";
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === "## CHANGES");
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.startsWith("### FILE:")) break;
    if (line !== "") return line;
  }
  return "";
}

export async function listCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: "string" } },
  });
  const root = findProjectRoot(process.cwd(), values.root);
  const ids = listHistoryIds(root);
  if (ids.length === 0) {
    out("履歴がありません。");
    return 0;
  }

  let total = 0;
  for (const id of [...ids].reverse()) {
    const dir = join(historyRoot(root), id);
    total += dirSize(dir);
    const m = readManifest(root, id);
    if (m === null) {
      out(`${id}  (manifest なし)`);
      continue;
    }
    const appliedCount = m.files.filter((f) => f.applied).length;
    const status = m.success ? "成功" : m.partial ? "部分適用" : "失敗";
    const summary = summaryLine(dir);
    out(`${id}  ${status}  ${appliedCount} ファイル  ${summary}`);
  }
  out("");
  out(`履歴 ${ids.length} 件 / 合計 ${formatSize(total)} (.petari/history)`);
  return 0;
}
