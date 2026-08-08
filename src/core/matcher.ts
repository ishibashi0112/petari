import type { ReplaceBlock } from "../types.ts";

/**
 * マッチした段階 (§6)。fuzzy マッチは事故のもとなので実装しない。
 * - exact:    完全一致
 * - trim-end: 各行の行末空白を無視して一致
 * - trim-all: 各行の前後空白を無視して一致 (REPLACE 側のインデントを元ファイルに合わせて補正)
 */
export type MatchStage = "exact" | "trim-end" | "trim-all";

export const STAGE_LABEL: Record<MatchStage, string> = {
  "exact": "完全一致",
  "trim-end": "行末空白無視",
  "trim-all": "インデント無視",
};

export type BlockFailureReason = "not-found" | "ambiguous";

export type BlockResult =
  | {
      ok: true;
      block: ReplaceBlock;
      stage: MatchStage;
      /** マッチ範囲 (このブロック適用直前の行配列に対する 0-based, end は排他) */
      start: number;
      end: number;
    }
  | {
      ok: false;
      block: ReplaceBlock;
      reason: BlockFailureReason;
      /** ambiguous のとき: どの段階で複数一致したか・その件数 */
      stage?: MatchStage;
      count?: number;
    };

export interface ApplyBlocksResult {
  /** 成功ブロックのみを順に適用した結果 (失敗ブロックはスキップ) */
  lines: string[];
  results: BlockResult[];
}

const STAGES: { stage: MatchStage; eq: (a: string, b: string) => boolean }[] = [
  { stage: "exact", eq: (a, b) => a === b },
  { stage: "trim-end", eq: (a, b) => a.trimEnd() === b.trimEnd() },
  { stage: "trim-all", eq: (a, b) => a.trim() === b.trim() },
];

function findMatches(
  lines: string[],
  search: string[],
  eq: (a: string, b: string) => boolean,
): number[] {
  const found: number[] = [];
  for (let i = 0; i + search.length <= lines.length; i++) {
    let all = true;
    for (let j = 0; j < search.length; j++) {
      if (!eq(lines[i + j] as string, search[j] as string)) {
        all = false;
        break;
      }
    }
    if (all) found.push(i);
  }
  return found;
}

function leadingWs(s: string): string {
  return s.slice(0, s.length - s.trimStart().length);
}

/** 非空行の先頭空白の最長共通プレフィックス (ブロックの基準インデント) */
function baseIndent(lines: string[]): string {
  const nonBlank = lines.filter((l) => l.trim() !== "");
  if (nonBlank.length === 0) return "";
  let prefix = leadingWs(nonBlank[0] as string);
  for (const line of nonBlank) {
    const ws = leadingWs(line);
    let k = 0;
    while (k < prefix.length && k < ws.length && prefix[k] === ws[k]) k++;
    prefix = prefix.slice(0, k);
  }
  return prefix;
}

/**
 * trim-all マッチ時の REPLACE 側インデント補正 (§6)。
 * SEARCH ブロックの基準インデントを、マッチした実ファイル範囲の基準インデントに
 * 置き換える。ブロック内の相対インデントは維持される。
 */
export function reindent(replaceLines: string[], searchBase: string, fileBase: string): string[] {
  return replaceLines.map((line) => {
    if (line.trim() === "") return line;
    if (line.startsWith(searchBase)) return fileBase + line.slice(searchBase.length);
    // 基準より浅い行 (通常は現れない) は自身のインデントを基準に付け替える
    return fileBase + line.trimStart();
  });
}

/** 1 ブロックを 2 段フォールバックでマッチさせ、適用後の置換行も算出する */
export function matchBlock(
  lines: string[],
  block: ReplaceBlock,
): BlockResult & { replacement?: string[] } {
  for (const { stage, eq } of STAGES) {
    const found = findMatches(lines, block.search, eq);
    if (found.length === 1) {
      const start = found[0] as number;
      const end = start + block.search.length;
      const replacement =
        stage === "trim-all"
          ? reindent(
              block.replace,
              baseIndent(block.search),
              baseIndent(lines.slice(start, end)),
            )
          : block.replace;
      return { ok: true, block, stage, start, end, replacement };
    }
    if (found.length > 1) {
      return { ok: false, block, reason: "ambiguous", stage, count: found.length };
    }
  }
  return { ok: false, block, reason: "not-found" };
}

/**
 * 同一ファイル内の複数ブロックを上から順に適用する (§6)。
 * 後続ブロックは先行ブロックの適用結果に対してマッチさせる。
 * 失敗ブロックはスキップして続行し、全ブロックの結果を返す
 * (all-or-nothing 判定と --partial の両方をこの結果で賄う)。
 */
export function applyBlocks(fileLines: string[], blocks: ReplaceBlock[]): ApplyBlocksResult {
  let lines = fileLines;
  const results: BlockResult[] = [];
  for (const block of blocks) {
    const m = matchBlock(lines, block);
    if (m.ok) {
      lines = [...lines.slice(0, m.start), ...(m.replacement as string[]), ...lines.slice(m.end)];
      results.push({ ok: true, block, stage: m.stage, start: m.start, end: m.end });
    } else {
      results.push(m);
    }
  }
  return { lines, results };
}
