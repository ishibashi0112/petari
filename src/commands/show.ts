/**
 * petari show <ID> — VS Code のネイティブ差分ビューで履歴を表示 (§4.3)。
 * - 既定: before vs after (AI の変更そのもの)
 * - --mine: after vs 現在のファイル = 適用後の手修正分だけを可視化
 * - --changes: 保存済み changes.md の CHANGES セクション (概要・Mermaid) を表示
 * 複数ファイルの履歴はファイル一覧を提示して選択させる (--file で直接指定も可)。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { invalidPathReason } from "../core/applier.ts";
import { parseChanges } from "../core/parser.ts";
import { loadConfig } from "../infra/config.ts";
import { historyRoot, listHistoryIds, readManifest, type ManifestFileEntry } from "../infra/history.ts";
import { createInterface } from "node:readline/promises";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";

const execFileP = promisify(execFile);

/**
 * vscodeCommand の形式制限 (セキュリティレビュー指摘 3)。
 * プロジェクト設定はリポジトリに同梱され得るため、リポジトリ内のスクリプトを
 * 指せる相対パス (./evil.sh 等) を拒否する。PATH 上のコマンド名か絶対パスのみ許可。
 */
export function invalidVscodeCommandReason(cmd: string): string | null {
  if (cmd.trim() === "") return "vscodeCommand が空です";
  if ((cmd.includes("/") || cmd.includes("\\")) && !isAbsolute(cmd)) {
    return "vscodeCommand に相対パスは使えません (コマンド名または絶対パスを指定してください)";
  }
  return null;
}

let emptyFileCache: string | null = null;
function emptyFile(): string {
  if (emptyFileCache === null) {
    emptyFileCache = join(mkdtempSync(join(tmpdir(), "petari-")), "empty");
    writeFileSync(emptyFileCache, "");
  }
  return emptyFileCache;
}

export interface DiffPair {
  left: string;
  right: string;
  title: string;
}

/** 差分対象のファイルパス組を解決する (create/delete の欠損側は空ファイル) */
export function resolveDiffPair(
  root: string,
  historyDir: string,
  entry: ManifestFileEntry,
  mine: boolean,
): DiffPair | { error: string } {
  const before = join(historyDir, "before", entry.path);
  const after = join(historyDir, "after", entry.path);
  const current = join(root, entry.path);
  if (mine) {
    if (entry.op === "delete") return { error: `${entry.path} は delete のため --mine の比較対象がありません` };
    if (!existsSync(current)) return { error: `${entry.path} は現在存在しません (undo 済み?)` };
    return { left: after, right: current, title: `${entry.path} (適用直後 → 現在 = 手修正分)` };
  }
  return {
    left: existsSync(before) ? before : emptyFile(),
    right: existsSync(after) ? after : emptyFile(),
    title: `${entry.path} (before → after)`,
  };
}

async function pickEntry(entries: ManifestFileEntry[]): Promise<ManifestFileEntry | null> {
  out("対象ファイルを選択してください:");
  entries.forEach((e, i) => out(`  ${i + 1}. ${e.op.padEnd(7)} ${e.path}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`番号 [1-${entries.length}]: `)).trim();
    const n = Number.parseInt(answer, 10);
    if (Number.isNaN(n) || n < 1 || n > entries.length) return null;
    return entries[n - 1] as ManifestFileEntry;
  } finally {
    rl.close();
  }
}

export async function showCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      mine: { type: "boolean", default: false },
      changes: { type: "boolean", default: false },
      file: { type: "string" },
    },
    allowPositionals: true,
  });
  const root = findProjectRoot(process.cwd(), values.root);
  const config = loadConfig(root);

  const ids = listHistoryIds(root);
  if (ids.length === 0) {
    err("petari: 履歴がありません");
    return 1;
  }
  const id = positionals[0] ?? (ids[ids.length - 1] as string);
  const manifest = readManifest(root, id);
  if (manifest === null) {
    err(`petari: 履歴 ${id} が見つかりません (petari list で確認してください)`);
    return 1;
  }
  const hdir = join(historyRoot(root), id);

  // --changes: CHANGES セクション (概要・影響一覧・Mermaid) の表示 (§13-4)
  if (values.changes) {
    const text = readFileSync(join(hdir, "changes.md"), "utf8");
    const { changeSet } = parseChanges(text);
    out(changeSet.header !== "" ? changeSet.header : "(CHANGES セクションがありません)");
    return 0;
  }

  const applied = manifest.files.filter((f) => f.applied);
  if (applied.length === 0) {
    err(`petari: 履歴 ${id} に適用済みファイルがありません`);
    return 1;
  }

  let entry: ManifestFileEntry;
  if (values.file !== undefined) {
    const found = applied.find((e) => e.path === values.file);
    if (found === undefined) {
      err(`petari: ${values.file} は履歴 ${id} にありません`);
      return 1;
    }
    entry = found;
  } else if (applied.length === 1) {
    entry = applied[0] as ManifestFileEntry;
  } else {
    const picked = await pickEntry(applied);
    if (picked === null) {
      err("petari: 中止しました");
      return 1;
    }
    entry = picked;
  }

  // manifest は改ざんされ得るため、パスと起動コマンドをここでも検証する (§9)
  const pathReason = invalidPathReason(entry.path);
  if (pathReason !== null) {
    err(`petari: manifest のパスが不正です: ${entry.path} (${pathReason})`);
    return 1;
  }
  const cmdReason = invalidVscodeCommandReason(config.vscodeCommand);
  if (cmdReason !== null) {
    err(`petari: ${cmdReason}: ${config.vscodeCommand}`);
    return 1;
  }

  const pair = resolveDiffPair(root, hdir, entry, values.mine);
  if ("error" in pair) {
    err(`petari: ${pair.error}`);
    return 1;
  }
  out(`${config.vscodeCommand} --diff で開きます: ${pair.title}`);
  try {
    await execFileP(config.vscodeCommand, ["--diff", pair.left, pair.right]);
  } catch (e) {
    err(`petari: ${config.vscodeCommand} の起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    err("  .petari/config.json の vscodeCommand を確認してください");
    return 1;
  }
  return 0;
}
