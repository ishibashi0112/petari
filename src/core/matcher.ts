import type { ReplaceBlock } from "../types.ts";

/**
 * マッチした段階 (§6)。fuzzy マッチ (編集距離・類似度) は事故のもとなので実装しない。
 * - exact:    完全一致
 * - trim-end: 各行の行末空白を無視して一致
 * - trim-all: 各行の前後空白を無視して一致 (REPLACE 側のインデントを元ファイルに合わせて補正)
 * - blank-insensitive: SEARCH と実ファイルの双方から空行を除いた上で trim-all 比較で一致
 *   (チャットサービスの添付・長文処理で空行が落ちたスナップショットを AI が読む事例への対策。
 *   空行の有無・数という決定論的でコードの意味を変えない差だけを吸収する)
 */
export type MatchStage = "exact" | "trim-end" | "trim-all" | "blank-insensitive";

export const STAGE_LABEL: Record<MatchStage, string> = {
  "exact": "完全一致",
  "trim-end": "行末空白無視",
  "trim-all": "インデント無視",
  "blank-insensitive": "空行差無視",
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
      /** ambiguous のとき: 各マッチの開始位置 (0-based 行番号)。レポートの位置表示用 */
      positions?: number[];
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

/**
 * 適用済み判定 (冪等性) 用の比較段階。ws-collapse は行内の連続空白・タブを 1 個の
 * 空白に圧縮して比較する (例: `Add(c)   ' コメント` と `Add(c) ' コメント` を同一視)。
 * 書き込みを伴わない「スキップしてよいか」の判定専用で、書き換え位置を決める
 * SEARCH のマッチング (STAGES) には使わない。
 */
export type PresenceStage = MatchStage | "ws-collapse";

export const PRESENCE_STAGE_LABEL: Record<PresenceStage, string> = {
  ...STAGE_LABEL,
  "ws-collapse": "空白圧縮一致",
};

const collapseWs = (s: string): string => s.trim().replace(/[ \t]+/g, " ");

const PRESENCE_STAGES: { stage: PresenceStage; eq: (a: string, b: string) => boolean }[] = [
  ...STAGES,
  { stage: "ws-collapse", eq: (a, b) => collapseWs(a) === collapseWs(b) },
];

/**
 * 適用済み判定: content ブロック全体 (複数行まるごと) が lines 内に存在するか。
 * 見つかった最初の (最も厳密な) 段階を返す。空・空行のみの content は偶然一致
 * しやすいため常に null (判定対象外 = 従来どおり失敗扱い)。
 */
export function findContentStage(lines: string[], content: string[]): PresenceStage | null {
  if (!content.some((l) => l.trim() !== "")) return null;
  for (const { stage, eq } of PRESENCE_STAGES) {
    if (findMatches(lines, content, eq).length > 0) return stage;
  }
  return null;
}

/**
 * 追記型ブロックの適用済み判定 (§6.1)。SEARCH が [start, end) に一意に一致したうえで、
 * 挿入しようとしている行 (candidates のいずれか) が「一致範囲を内側に含む形で」既に
 * ファイルにあるかを調べる。REPLACE が SEARCH を包含する追記型 (SEARCH `A` → REPLACE
 * `A` + `B`) は適用後も SEARCH が一致し続けるため、SEARCH 不一致を起点とする
 * findContentStage では拾えず、再実行で `B` が重複していた。
 *
 * - 比較は空行を除いた行列で行う (空行の欠落・追加だけの差は同一視)。空行まで含めて
 *   一致すれば exact / trim-end、空行の並びだけ異なれば blank-insensitive を返す
 * - 各行の比較は exact → trim-end のみ。インデント違いは別物として扱う
 *   (入れ子の End If を補う変更を、隣の外側の End If を根拠に「済み」と誤判定しないため)
 * - 一致範囲の外に内容のある行を 1 行以上足すものだけが対象。SEARCH と同数以下
 *   (インデント修正などの書き換え) は null
 *
 * candidates には reindent 済みの置換行と REPLACE の原文を渡す (前回 trim-all で一致して
 * 補正後の行が入っている場合と、原文のまま入っている場合の両方を拾うため)。
 */
export function findInsertionPresenceStage(
  lines: string[],
  start: number,
  end: number,
  candidates: string[][],
): PresenceStage | null {
  const nonBlank: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim() !== "") nonBlank.push(i);
  });
  const first = nonBlank.findIndex((i) => i >= start);
  const matched = nonBlank.filter((i) => i >= start && i < end).length;
  if (first < 0 || matched === 0) return null;
  for (const { stage, eq } of STAGES.slice(0, 2)) {
    for (const rep of candidates) {
      const repIdx: number[] = [];
      rep.forEach((line, i) => {
        if (line.trim() !== "") repIdx.push(i);
      });
      if (repIdx.length <= matched) continue;
      // q = REPLACE 内で一致範囲 (の最初の非空行) が始まる位置 (非空行単位)
      for (let q = 0; q + matched <= repIdx.length; q++) {
        const from = first - q;
        if (from < 0 || from + repIdx.length > nonBlank.length) continue;
        const all = repIdx.every((r, j) =>
          eq(lines[nonBlank[from + j] as number] as string, rep[r] as string),
        );
        if (!all) continue;
        // 空行の並びまで同じか (ラベル用)
        const lo = nonBlank[from] as number;
        const hi = (nonBlank[from + repIdx.length - 1] as number) + 1;
        const repLo = repIdx[0] as number;
        const repHi = (repIdx[repIdx.length - 1] as number) + 1;
        const sameLayout =
          hi - lo === repHi - repLo &&
          lines.slice(lo, hi).every((line, k) => eq(line, rep[repLo + k] as string));
        return sameLayout ? stage : "blank-insensitive";
      }
    }
  }
  return null;
}

/** 適用済み判定 (rewrite/create): content がファイル全行と一致するか */
export function contentEqualsStage(lines: string[], content: string[]): PresenceStage | null {
  if (lines.length !== content.length) return null;
  for (const { stage, eq } of PRESENCE_STAGES) {
    if (lines.every((line, i) => eq(line, content[i] as string))) return stage;
  }
  return null;
}

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

/**
 * 4 段目 blank-insensitive (§6): SEARCH と実ファイルの双方から空行を除いた行列を
 * trim-all 比較 (a.trim() === b.trim()) で連続一致探索する。マッチ範囲は最初と最後の
 * 非空行で囲まれた元ファイル範囲 (内部の空行は含む、外側の空行は含まない)。
 * SEARCH の先頭・末尾の空行は照合範囲に含めず、実ファイル側の外側の空行はそのまま残る。
 * REPLACE 側の空行はそのまま挿入する (意図的な空行挿入を潰さないため、勝手に削らない)。
 * 見つからないときは null (呼び出し元が not-found にする)。
 */
function matchBlankInsensitive(
  lines: string[],
  block: ReplaceBlock,
): (BlockResult & { replacement?: string[] }) | null {
  const searchNonBlank = block.search.filter((l) => l.trim() !== "");
  // SEARCH が空行のみなら試行しない (どこにでも一致し得るため)
  if (searchNonBlank.length === 0) return null;
  const fileNonBlank: string[] = [];
  const origIdx: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim() !== "") {
      fileNonBlank.push(line);
      origIdx.push(i);
    }
  });
  const found = findMatches(fileNonBlank, searchNonBlank, (a, b) => a.trim() === b.trim());
  if (found.length === 0) return null;
  if (found.length > 1) {
    return {
      ok: false,
      block,
      reason: "ambiguous",
      stage: "blank-insensitive",
      count: found.length,
      positions: found.map((h) => origIdx[h] as number),
    };
  }
  const hit = found[0] as number;
  const start = origIdx[hit] as number;
  const end = (origIdx[hit + searchNonBlank.length - 1] as number) + 1;
  const replacement = reindent(
    block.replace,
    baseIndent(block.search),
    baseIndent(lines.slice(start, end)),
  );
  return { ok: true, block, stage: "blank-insensitive", start, end, replacement };
}

/** 1 ブロックを段階フォールバック (STAGES → blank-insensitive) でマッチさせ、適用後の置換行も算出する */
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
      return { ok: false, block, reason: "ambiguous", stage, count: found.length, positions: found };
    }
  }
  const blankInsensitive = matchBlankInsensitive(lines, block);
  if (blankInsensitive !== null) return blankInsensitive;
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
