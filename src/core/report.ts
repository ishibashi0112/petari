/**
 * 失敗レポート (§7)。そのまま AI チャットに貼り返せる形式で出力する。
 *
 * 2026-08-25 の実運用事例 (AI が失敗原因を空白/エンコーディング差と誤診し、SEARCH の
 * 空白調整や ASCII 化に 4 往復を浪費) を受けて、レポートに次を含める:
 * - petari の照合仕様 (空白・エンコーディング差は吸収済み = 失敗は文字内容の差) の明記
 * - 全ファイル・全ブロックの検証結果一覧 (どこが通りどこが落ちたかの対比が診断の鍵)
 * - all-or-nothing で未書き込みであることの明記 (端末表示はチャットに貼られないため)
 * - block-not-found への実ファイル近傍抜粋 (nearest.ts。AI が推測せずコピーで直せる)
 */
import type { Failure } from "./applier.ts";
import type { FileOutcome } from "./applier.ts";
import { STAGE_LABEL } from "./matcher.ts";
import { renderNearest, renderNearestReplace } from "./nearest.ts";
import type { ParseIssue } from "../types.ts";

const MATCH_SPEC_NOTE = [
  "## petari の照合仕様 (SEARCH を修正する前に必ず読んでください)",
  "",
  "- petari は行末空白・インデントの深さ (タブ/スペース混在含む)・改行コード・文字コード",
  "  (UTF-8 / Shift_JIS) の違いを自動で吸収して照合しています",
  "- ただし空行は「内容のある 1 行」として数えます。SEARCH と実ファイルで空行の位置・数が",
  "  違うと一致しません (スナップショット生成ツールやチャット側の表示で空行が落ちる事例が",
  "  あります。抜粋では実ファイル側にだけある行を + で示します)",
  "- したがって「SEARCH が見つかりません」は行内の空白・インデント・エンコーディングの問題では",
  "  ありません。行の文字内容か、行の構成 (空行を含む行の過不足) が現在のファイルと異なっています",
  "- 行内空白の調整・ASCII 行だけへの縮小・別アンカーへの乗り換えでは解決しません。各失敗に",
  "  添付した「実ファイルの該当箇所」の抜粋から、行をそのままコピーしてください",
];

const RE_REQUEST = `## 依頼

上記の失敗した各ブロックについて、SEARCH 部分を現在のファイル内容と完全に一致するよう修正し、
changes.md 全体を元の規約フォーマット (## CHANGES から始まる形式) で再出力してください。
- SEARCH の修正には「実ファイルの該当箇所」の抜粋を使い、「│」より右側を一字一句そのまま
  コピーしてください (行頭の「! ~ = +」の記号と行番号は含めません。+ の行 (空行含む) も
  SEARCH に含めます)
- SEARCH ブロックにはファイル内で一意に特定できる範囲を含めてください
- 失敗していないファイル・ブロックも含めた完全な changes.md を出力してください
- 抜粋にも SEARCH に相当する行が見当たらない場合は、推測で書き換えず、その旨を報告して
  最新のファイル内容の共有を依頼してください`;

export interface FailureReportContext {
  /** 全ファイル・全ブロックの検証結果一覧を載せる (成功/失敗の対比が原因切り分けの鍵) */
  outcomes?: FileOutcome[];
  /** all-or-nothing により何も書き込んでいないことを明記する */
  nothingWritten?: boolean;
}

/** 検証結果の一覧 (成功したブロックも含めて全て)。ファイル間の対比が診断材料になる */
function outcomeSummary(outcomes: FileOutcome[]): string[] {
  const lines: string[] = ["## 検証結果の一覧 (全ファイル・全ブロック)", ""];
  for (const o of outcomes) {
    const c = o.change;
    if (c.op !== "replace") {
      const status =
        o.failures.length > 0
          ? `NG (${o.failures[0]?.message})`
          : o.alreadyApplied
            ? "OK (適用済みのためスキップ)"
            : "OK (検証通過)";
      lines.push(`- ${c.path} (${c.op}): ${status}`);
      continue;
    }
    const fileLevel = o.failures.find((f) => f.block === undefined);
    if (fileLevel !== undefined) {
      lines.push(`- ${c.path} (replace): NG (${fileLevel.message})`);
      continue;
    }
    const okCount = o.appliedBlocks.length + o.alreadyAppliedBlocks.length;
    lines.push(`- ${c.path} (replace): ${okCount}/${o.totalBlocks} ブロック一致`);
    const byIndex = new Map<number, string>();
    for (const b of o.appliedBlocks) {
      byIndex.set(b.block.index, `OK 一致 (${STAGE_LABEL[b.stage]})`);
    }
    for (const b of o.alreadyAppliedBlocks) {
      byIndex.set(b.block.index, "OK 適用済み (REPLACE が既に存在)");
    }
    for (const f of o.failures) {
      if (f.block === undefined) continue;
      const label =
        f.kind === "block-ambiguous"
          ? "NG 複数箇所に一致 (一意でない)"
          : f.kind === "unencodable"
            ? "NG 変換できない文字を含む"
            : "NG SEARCH 不一致 (詳細は下記)";
      byIndex.set(f.block.index, label);
    }
    for (const [index, status] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`    - ブロック ${index}: ${status}`);
    }
  }
  lines.push(...remainingSummary(outcomes));
  return lines;
}

/**
 * 「残り何ブロックを直せば全適用できるか」の構造化サマリ (§7)。
 * all-or-nothing の設計上、あと 1 ブロックで全通しの状態を明示すると再出力の
 * 修正ポイントが絞れる (2026-08-25 実運用フィードバック)。
 */
function remainingSummary(outcomes: FileOutcome[]): string[] {
  let totalUnits = 0;
  let failedUnits = 0;
  for (const o of outcomes) {
    if (o.change.op === "replace" && o.totalBlocks > 0) {
      totalUnits += o.totalBlocks;
      const fileLevel = o.failures.some((f) => f.block === undefined);
      failedUnits += fileLevel ? o.totalBlocks : o.failures.length;
    } else {
      totalUnits += 1;
      if (o.failures.length > 0) failedUnits += 1;
    }
  }
  if (failedUnits === 0 || failedUnits >= totalUnits) return [];
  const passed = totalUnits - failedUnits;
  return [
    "",
    failedUnits === 1
      ? `→ 失敗は全 ${totalUnits} ブロック中この 1 ブロックだけです。この 1 ブロックの SEARCH を修正すれば全体が適用可能になります。`
      : `→ 全 ${totalUnits} ブロック中 ${passed} ブロックは検証を通過しています。残る ${failedUnits} ブロックの SEARCH を修正すれば全体が適用可能になります。`,
  ];
}

/** 検証失敗 (マッチング・パス・エンコーディング) のレポート */
export function buildFailureReport(failures: Failure[], ctx: FailureReportContext = {}): string {
  const parts: string[] = ["以下の変更ブロックが現在のコードベースに適用できませんでした。"];
  if (ctx.nothingWritten === true) {
    parts.push(
      "",
      "※ この失敗により petari は何も書き込んでいません (all-or-nothing)。下の一覧で「一致」と",
      "表示されたブロックもまだファイルには適用されていないため、再出力には失敗していない",
      "ブロックもすべて含めてください。",
    );
  }
  parts.push("", ...MATCH_SPEC_NOTE);
  if (ctx.outcomes !== undefined) {
    parts.push("", ...outcomeSummary(ctx.outcomes));
  }
  parts.push("", "## 適用失敗の詳細");
  for (const f of failures) {
    parts.push("", `### ${f.path}`, `失敗理由: ${f.message}`);
    if (f.block !== undefined) {
      parts.push(
        "",
        "```",
        "<<<<<<< SEARCH",
        ...f.block.search,
        "=======",
        ...f.block.replace,
        ">>>>>>> REPLACE",
        "```",
      );
    }
    if (f.nearest !== undefined) {
      parts.push("", ...renderNearest(f.nearest));
    }
    if (f.nearestReplace !== undefined) {
      parts.push("", ...renderNearestReplace(f.nearestReplace));
    }
  }
  parts.push("", RE_REQUEST, "");
  return parts.join("\n");
}

/** 構文エラー (パース失敗) のレポート。規約文がチャット側で失われていても
 * このレポート単体で再出力を依頼できるよう、フォーマットの要点を再掲する */
export function buildParseErrorReport(issues: ParseIssue[]): string {
  const parts: string[] = [
    "受け取った changes.md が規約フォーマットとして解釈できませんでした。",
    "",
    "## 構文エラーの詳細",
    "",
    ...issues.map((i) => `- ${i.line} 行目: ${i.message}`),
    "",
    "## 規約フォーマットの要点 (再掲)",
    "",
    "- 出力は必ず行頭の「## CHANGES」の行から始め、変更概要のあとに各ファイルのセクションを置く",
    "- 各ファイルは「### FILE: 相対パス (replace|create|rewrite|delete)」の見出し行で始める",
    "- replace は <<<<<<< SEARCH / ======= / >>>>>>> REPLACE のブロックで書き、",
    "  SEARCH の内容は現在のファイルから一字一句そのままコピーする",
    "- create / rewrite は <<<<<<< CONTENT / >>>>>>> END のブロックにファイル全文を書く。delete は本文なし",
    "- マーカー行は必ず行頭から書き、前後に他の文字を付けない (< > = はいずれも 7 個)",
    "- 出力全体や各ブロックをコードフェンス (```) で包まない",
    "- FILE セクションの間に説明文を書かない (説明は冒頭の CHANGES セクションへ)",
    "",
    "## 依頼",
    "",
    "上記の構文エラーを修正し、changes.md 全体を規約フォーマット (## CHANGES から始まり、",
    "### FILE: 行と <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 等のマーカーを行頭に置く形式) で",
    "再出力してください。失敗していないファイル・ブロックも含めた完全な changes.md を出力してください。",
    "",
  ];
  return parts.join("\n");
}
