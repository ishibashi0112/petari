/**
 * petari [path] — 適用コマンド (§4.1)。
 * 手順: パース → 全件ドライラン検証 → (失敗があれば何も書かずレポート) →
 * before 保存 → 書き換え → after 保存 → サマリ表示。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  invalidPathReason,
  planChangeSet,
  type FileOutcome,
  type FileState,
  type Plan,
} from "../core/applier.ts";
import { parseChanges } from "../core/parser.ts";
import { buildFailureReport, buildParseErrorReport } from "../core/report.ts";
import { readClipboard, writeClipboard } from "../infra/clipboard.ts";
import { loadConfig } from "../infra/config.ts";
import {
  findRecentChangesFiles,
  resolveDownloadsDir,
  type CandidateFile,
} from "../infra/downloads.ts";
import { deleteFile, isInsideRoot, readFileState, sha256, writeBytes } from "../infra/files.ts";
import { gitDirtyFiles } from "../infra/git.ts";
import { err, out } from "../infra/term.ts";
import {
  beginHistory,
  createHistoryId,
  finishHistory,
  pruneHistory,
  type Manifest,
  type ManifestFileEntry,
} from "../infra/history.ts";
import { confirm } from "../infra/prompt.ts";
import { findProjectRoot } from "../infra/root.ts";

/** --partial 時: このファイルは書き込み対象か */
function isApplicable(o: FileOutcome): boolean {
  if (o.failures.length === 0) return true;
  return o.change.op === "replace" && o.appliedBlocks.length > 0;
}

function opLabel(o: FileOutcome): string {
  const c = o.change;
  if (c.op === "replace") return `replace ${c.path} — ${o.appliedBlocks.length}/${o.totalBlocks} ブロック`;
  return `${c.op.padEnd(7)} ${c.path}`;
}

function printPreview(outcomes: FileOutcome[]): void {
  for (const o of outcomes) {
    out(`  ${opLabel(o)}`);
    for (const b of o.appliedBlocks) {
      out(`    @@ ${o.change.path}:${b.start + 1} (${b.stage})`);
      for (const l of b.removed) out(`    - ${l}`);
      for (const l of b.inserted) out(`    + ${l}`);
    }
  }
}

export async function applyCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      partial: { type: "boolean", default: false },
      root: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      clip: { type: "boolean", default: false },
      "clip-report": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const root = findProjectRoot(process.cwd(), values.root);
  const config = loadConfig(root);
  if (!existsSync(join(root, ".petari"))) {
    out("ヒント: 初回は `petari init` を実行すると protocol.md や設定の雛形が整います");
  }

  // レポートを標準出力へ出し、--clip-report ならクリップボードにもコピーする (§7)
  const emitReport = async (report: string): Promise<void> => {
    out(report);
    if (values["clip-report"]) {
      try {
        await writeClipboard(report);
        out("(レポートをクリップボードにコピーしました)");
      } catch (e) {
        err(`petari: クリップボードへのコピーに失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const stripBom = (s: string): string => s.replace(/^\uFEFF/, "");

  // 入力ソースの優先順位 (§4.1): 引数 > --clip > Downloads 自動検出
  let changesText: string;
  let source: Manifest["source"];
  const inputPath = positionals[0];
  if (inputPath !== undefined) {
    const abs = resolve(process.cwd(), inputPath);
    try {
      changesText = stripBom(readFileSync(abs, "utf8"));
    } catch {
      err(`petari: ファイルを読めません: ${abs}`);
      return 1;
    }
    source = { type: "file", path: abs };
  } else if (values.clip) {
    try {
      changesText = stripBom(await readClipboard());
    } catch (e) {
      err(`petari: クリップボードを読めません: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (changesText.trim() === "") {
      err("petari: クリップボードが空です");
      return 1;
    }
    source = { type: "clipboard" };
  } else {
    const downloadsDir = await resolveDownloadsDir(config.downloadsDir);
    const candidates = findRecentChangesFiles(downloadsDir, new Date());
    if (candidates.length === 0) {
      err(`petari: ${downloadsDir} に直近 30 分以内の changes*.md が見つかりません`);
      err("  ファイルパスを指定するか、--clip でクリップボードから読み込んでください");
      return 1;
    }
    const newest = candidates[0] as CandidateFile;
    out(`Downloads から検出: ${newest.path}`);
    if (candidates.length > 1) {
      out(`  (他 ${candidates.length - 1} 件の候補があります。最新を使用します)`);
      for (const c of candidates.slice(1)) out(`    - ${c.path}`);
      if (!values.yes && !(await confirm("このファイルを適用しますか?"))) {
        out("中止しました。");
        return 1;
      }
    }
    try {
      changesText = stripBom(readFileSync(newest.path, "utf8"));
    } catch {
      err(`petari: ファイルを読めません: ${newest.path}`);
      return 1;
    }
    source = { type: "downloads", path: newest.path };
  }

  // 1. パース (構文エラーは即時失敗・§4.1)
  const { changeSet, issues } = parseChanges(changesText);
  if (issues.length > 0) {
    err("petari: changes.md の構文エラーです。何も書き込んでいません。\n");
    await emitReport(buildParseErrorReport(issues));
    return 1;
  }

  // 2. 全ブロックのドライラン検証
  const states = new Map<string, FileState>();
  for (const f of changeSet.files) {
    if (invalidPathReason(f.path) !== null) {
      states.set(f.path, { exists: false, symlink: false, bytes: null });
      continue;
    }
    const abs = join(root, f.path);
    // symlink ディレクトリ経由でルート外に出るパスは検証段階で失敗させる (§9)
    if (!isInsideRoot(root, abs)) {
      states.set(f.path, { exists: false, symlink: false, bytes: null, escapesRoot: true });
      continue;
    }
    states.set(f.path, readFileState(abs));
  }
  const plan: Plan = planChangeSet(changeSet, states, config.newFile);

  // 3. 失敗があれば何も書き込まずレポート (§4.1, §7)
  if (!plan.ok && !values.partial) {
    err(`petari: 検証に失敗しました (${plan.failures.length} 件)。何も書き込んでいません。\n`);
    await emitReport(buildFailureReport(plan.failures));
    return 1;
  }
  const applicable = plan.outcomes.filter(isApplicable);
  if (applicable.length === 0) {
    err("petari: 適用できる変更がありません。\n");
    await emitReport(buildFailureReport(plan.failures));
    return 1;
  }

  if (values["dry-run"]) {
    out(`dry-run: 適用予定 ${applicable.length} ファイル (書き込みなし)`);
    printPreview(applicable);
    if (plan.failures.length > 0) {
      out("");
      await emitReport(buildFailureReport(plan.failures));
    }
    return 0;
  }

  // 確認 (§4.1, §9)
  out(`プロジェクトルート: ${root}`);
  out(`適用予定 ${applicable.length} ファイル:`);
  for (const o of applicable) out(`  ${opLabel(o)}`);
  if (plan.failures.length > 0) {
    out(`  (検証失敗 ${plan.failures.length} 件は --partial によりスキップ)`);
  }
  const dirty = await gitDirtyFiles(root);
  if (dirty !== null && dirty.length > 0) {
    out(`警告: Git 作業ツリーに未コミットの変更が ${dirty.length} 件あります`);
  }
  if (!values.yes) {
    if (!(await confirm("適用しますか?"))) {
      out("中止しました。");
      return 1;
    }
  }

  // 4. before 保存 → 書き換え → after 保存 (§4.1 手順 4, §5)
  const id = createHistoryId(root, new Date());
  const before = new Map<string, Uint8Array | null>();
  for (const o of applicable) {
    before.set(o.change.path, states.get(o.change.path)?.bytes ?? null);
  }
  beginHistory(root, id, changesText, before);

  const after = new Map<string, Uint8Array | null>();
  for (const o of applicable) {
    const abs = join(root, o.change.path);
    if (o.change.op === "delete") {
      deleteFile(abs);
      after.set(o.change.path, null);
    } else {
      writeBytes(abs, o.afterBytes as Uint8Array);
      after.set(o.change.path, o.afterBytes);
    }
  }

  const entries: ManifestFileEntry[] = plan.outcomes.map((o) => {
    const applied = isApplicable(o);
    const beforeBytes = states.get(o.change.path)?.bytes ?? null;
    const afterBytes = applied ? (after.get(o.change.path) ?? null) : null;
    const skipped = o.failures
      .filter((f) => f.block !== undefined)
      .map((f) => ({ index: (f.block as { index: number }).index, reason: f.message }));
    const entry: ManifestFileEntry = {
      path: o.change.path,
      op: o.change.op,
      applied,
      blocks: o.totalBlocks,
      appliedBlocks: o.appliedBlocks.length,
      beforeSha256: beforeBytes !== null ? sha256(beforeBytes) : null,
      afterSha256: afterBytes !== null ? sha256(afterBytes) : null,
    };
    if (skipped.length > 0) entry.skippedBlocks = skipped;
    return entry;
  });
  const manifest: Manifest = {
    id,
    appliedAt: new Date().toISOString(),
    success: plan.ok,
    partial: values.partial,
    source,
    files: entries,
  };
  finishHistory(root, id, manifest, after);
  const pruned = pruneHistory(root, config.historyLimit);
  if (pruned.length > 0) {
    out(`古い履歴 ${pruned.length} 件を削除しました (historyLimit: ${config.historyLimit})`);
  }

  // 5. サマリ (§4.1 手順 5)
  out("");
  out(`適用しました (履歴 ID: ${id})`);
  for (const o of applicable) out(`  ${opLabel(o)}`);
  if (plan.failures.length > 0) {
    out(`スキップした失敗 ${plan.failures.length} 件のレポート:`);
    out("");
    await emitReport(buildFailureReport(plan.failures));
  }

  // 6. Downloads 由来なら changes.md を履歴へ移動 (原本は history に保存済み・§4.1)
  if (source.type === "downloads" && source.path !== undefined) {
    try {
      deleteFile(source.path);
      out(`Downloads の ${source.path} を履歴へ移動しました`);
    } catch {
      err(`petari: ${source.path} を削除できませんでした (履歴には保存済み)`);
    }
  }

  out("");
  out("git diff で差分を確認してください。巻き戻しは `petari undo` です。");
  return 0;
}
