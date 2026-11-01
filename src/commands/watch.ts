/**
 * tazuna watch — Downloads とプロジェクト直下を監視し、届いた changes*.md を自動で適用する (§4.7)。
 * 新着 1 件ごとに applyCommand へ確認なしで渡す。検証・失敗レポートの自動コピー・
 * 二重適用の防止・成功後の履歴への移動は `tazuna` (引数なし) と同じ。Ctrl+C で終了する。
 */
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { TOOL_NAME } from "../brand.ts";
import { hasChangesHeading } from "../core/parser.ts";
import { initialWatchState, observeWatch, type WatchedFile } from "../core/watch.ts";
import { loadConfig } from "../infra/config.ts";
import { listChangesFiles, resolveDownloadsDir } from "../infra/downloads.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";
import { applyCommand, type DetectedChanges } from "./apply.ts";

export interface WatchOptions {
  /** 監視を止める合図 (テスト用。指定がなくても Ctrl+C で止まる) */
  signal?: AbortSignal;
  /** 観測の間隔 (ミリ秒)。テスト用 */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;

export async function watchCommand(argv: string[], options: WatchOptions = {}): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-vbproj": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const root = findProjectRoot(process.cwd(), values.root);
  const config = loadConfig(root);
  const downloadsDir = await resolveDownloadsDir(config.downloadsDir);

  // Downloads を先に並べ、同じパスはその由来で扱う (apply の自動検出と同じ)
  type Found = WatchedFile & { origin: DetectedChanges["origin"] };
  const list = (): Found[] => {
    const seen = new Set<string>();
    return [
      ...listChangesFiles(downloadsDir).map((f) => ({ ...f, origin: "downloads" as const })),
      ...listChangesFiles(root).map((f) => ({ ...f, origin: "project-root" as const })),
    ].filter((f) => !seen.has(f.path) && (seen.add(f.path), true));
  };

  const stop = new AbortController();
  const onSigint = (): void => stop.abort();
  process.once("SIGINT", onSigint);
  const onAbort = (): void => stop.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) stop.abort();

  const applyArgs = ["--root", root, "--yes"];
  if (values["dry-run"]) applyArgs.push("--dry-run");
  if (values["no-vbproj"]) applyArgs.push("--no-vbproj");

  try {
    // 開始時に既にあるファイルは対象外 (古い changes.md を黙って当てない)
    const state = initialWatchState(list());
    out("changes*.md の到着を待っています。届いたら確認なしで適用します (Ctrl+C で終了)");
    out(`  Downloads:        ${downloadsDir}`);
    out(`  プロジェクト直下: ${root}`);
    if (values["dry-run"]) out("  --dry-run: 検証と差分プレビューだけで、書き込みはしません");
    if (state.settled.size > 0) {
      out(`  (既にある ${state.settled.size} 件は対象外です。それを当てるときは ${TOOL_NAME} を実行してください)`);
    }

    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    while (!stop.signal.aborted) {
      try {
        await delay(interval, undefined, { signal: stop.signal });
      } catch {
        break; // 中断
      }
      for (const f of observeWatch(state, list())) {
        if (stop.signal.aborted) break;
        out("");
        out(`━━ 新しい changes.md: ${f.path}`);
        let text: string;
        try {
          text = readFileSync(f.path, "utf8");
        } catch {
          err(`${TOOL_NAME}: ファイルを読めません: ${f.path}`);
          continue;
        }
        // 変更履歴の CHANGES.md 等を当てに行かない (失敗レポートでクリップボードを上書きしないため)
        if (!hasChangesHeading(text.replace(/^﻿/, ""))) {
          out("  ## CHANGES の見出しがないため、changes.md ではないと判断して適用しません");
          out(`  (AI の返答なら \`${TOOL_NAME} <パス>\` で実行すると失敗の理由を確認できます)`);
          continue;
        }
        try {
          await applyCommand(applyArgs, { path: f.path, origin: f.origin });
        } catch (e) {
          // 1 件の失敗で監視ごと止めない
          err(`${TOOL_NAME}: ${e instanceof Error ? e.message : String(e)}`);
        }
        out("");
        out("引き続き待っています (Ctrl+C で終了)");
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onAbort);
  }
  out("監視を終了しました。");
  return 0;
}
