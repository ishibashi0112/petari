/**
 * petari undo [ID] — 履歴の巻き戻し (§4.2)。
 * manifest の操作種別に基づき逆適用する:
 *   replace/rewrite → before を書き戻し / create → ファイル削除 / delete → before から復元
 * 適用後に手修正されている場合 (現状ハッシュ ≠ after ハッシュ) は警告して確認する。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { invalidPathReason } from "../core/applier.ts";
import { loadConfig } from "../infra/config.ts";
import { deleteFile, isInsideRoot, readFileState, sha256, writeBytes } from "../infra/files.ts";
import { historyRoot, listHistoryIds, readManifest, type ManifestFileEntry } from "../infra/history.ts";
import { confirm } from "../infra/prompt.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";

interface UndoAction {
  entry: ManifestFileEntry;
  /** 書き戻す内容 (create の巻き戻しは null = 削除) */
  restoreBytes: Uint8Array | null;
  /** 適用後に手修正されている (現状 ≠ after) */
  modified: boolean;
}

export async function undoCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
    allowPositionals: true,
  });
  const root = findProjectRoot(process.cwd(), values.root);
  loadConfig(root); // 設定エラーの早期検出のみ

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
  const applied = manifest.files.filter((f) => f.applied);
  if (applied.length === 0) {
    err(`petari: 履歴 ${id} に適用済みファイルがありません`);
    return 1;
  }

  // 逆適用の材料を全件検証してから書き込む (undo 自体も all-or-nothing)
  const actions: UndoAction[] = [];
  for (const entry of applied) {
    // manifest は改ざんされ得るため、apply と同じパス検証をここでも行う (§9)
    const pathReason = invalidPathReason(entry.path);
    if (pathReason !== null) {
      err(`petari: manifest のパスが不正です: ${entry.path} (${pathReason})`);
      return 1;
    }
    const abs = join(root, entry.path);
    if (!isInsideRoot(root, abs)) {
      err(`petari: manifest のパスがプロジェクトルートの外を指しています: ${entry.path}`);
      return 1;
    }
    const current = readFileState(abs);
    if (current.symlink) {
      err(`petari: シンボリックリンクは巻き戻し対象外です: ${entry.path}`);
      return 1;
    }
    let restoreBytes: Uint8Array | null = null;
    if (entry.op !== "create") {
      const beforePath = join(hdir, "before", entry.path);
      if (!existsSync(beforePath)) {
        err(`petari: 履歴の before ファイルが欠損しています: ${beforePath}`);
        return 1;
      }
      restoreBytes = new Uint8Array(readFileSync(beforePath));
    }
    const modified =
      entry.op === "delete"
        ? current.exists // delete したはずのファイルが存在する
        : !current.exists ||
          current.bytes === null ||
          sha256(current.bytes) !== entry.afterSha256;
    actions.push({ entry, restoreBytes, modified });
  }

  const modified = actions.filter((a) => a.modified);
  out(`履歴 ${id} を巻き戻します (${applied.length} ファイル)`);
  if (modified.length > 0) {
    out("警告: 適用後に手修正されたファイルがあります。巻き戻すと手修正が失われます:");
    for (const a of modified) out(`  ${a.entry.path}`);
  }
  if (!values.yes) {
    if (!(await confirm(modified.length > 0 ? "手修正が失われますが戻しますか?" : "巻き戻しますか?"))) {
      out("中止しました。");
      return 1;
    }
  }

  for (const a of actions) {
    const abs = join(root, a.entry.path);
    if (a.entry.op === "create") {
      if (existsSync(abs)) deleteFile(abs);
      out(`  削除: ${a.entry.path} (create の巻き戻し)`);
    } else {
      writeBytes(abs, a.restoreBytes as Uint8Array);
      out(`  復元: ${a.entry.path}`);
    }
  }
  out(`巻き戻しました (履歴 ID: ${id})`);
  return 0;
}
