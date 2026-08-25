/**
 * SEARCH 不一致時の近傍診断 (§7 失敗レポートの拡充)。
 * 実ファイル内で SEARCH に最も近い領域を特定し、どの行がどう違うかを構造化して返す。
 * I/O を持たない純粋ロジック。レポートの文字列化は renderNearest が行う。
 *
 * 2026-08-25 の実運用事例 (AI が失敗原因を空白/エンコーディングと誤診し 4 往復) を受けて追加。
 * 抜粋行は verbatim で保持する — AI がそのまま次の SEARCH へコピーする前提のため、
 * 制御文字の可視化などの加工は行わない (差分の説明は note 側に分離する)。
 */

/** ウィンドウ内の 1 行と SEARCH 対応行の照合結果 */
export type LineVerdict = "match" | "ws-only" | "differ";

export interface LineHit {
  /** SEARCH 内の行番号 (1-based) */
  index: number;
  /** SEARCH の行テキスト (原文) */
  text: string;
  /** 前後空白を無視した一致がファイル内に何箇所あるか */
  count: number;
}

export interface WindowLine {
  /** 実ファイルの行番号 (1-based) */
  lineNo: number;
  /** 実ファイルの行テキスト (verbatim。SEARCH へのコピー元になるため加工しない) */
  text: string;
  /** SEARCH 対応行との照合結果。前後のコンテキスト行は null */
  verdict: LineVerdict | null;
  /** 不一致行の補足説明 (空白の個数差・不可視文字の差など) */
  note?: string;
}

export interface NearestWindow {
  /** SEARCH の行数 */
  total: number;
  /** ウィンドウ内で一致 (前後空白無視) した行数 */
  matchCount: number;
  lines: WindowLine[];
}

export interface NearestAnalysis {
  /** SEARCH 各行 (空行を除く) の実ファイル内での出現数 */
  lineHits: LineHit[];
  /** 最も一致行数の多い領域。1 行も (空白圧縮でも) 一致しなければ null */
  window: NearestWindow | null;
  /** 同一ファイル内の先行ブロック適用後の行配列を基準にしているか */
  afterPriorBlocks: boolean;
}

/** 前後のコンテキストとして抜粋に含める行数 */
const CONTEXT_LINES = 2;
/** レポートに載せるウィンドウの最大行数 (巨大 SEARCH の暴走防止) */
const MAX_RENDER_LINES = 40;
/** 「存在しない行」一覧の最大表示数 */
const MAX_MISSING_LINES = 8;

const collapseWs = (s: string): string => s.replace(/[ \t]+/g, " ");

/**
 * 目視で区別しづらい文字を通常の文字へ畳み込む。畳み込み後に一致するなら、
 * その行の差は「見えない文字」だけに因る (レポートでコードポイントを示す価値がある)。
 */
const FOLD_RULES: [RegExp, string][] = [
  [/[\u3000\u00A0]/g, " "], // 全角スペース / ノーブレークスペース
  [/[\u200B-\u200D\uFEFF]/g, ""], // ゼロ幅文字
  [/\u301C/g, "\uFF5E"], // 波ダッシュ ↔ 全角チルダ (Shift_JIS デコーダ差の定番)
];
const foldConfusable = (s: string): string =>
  FOLD_RULES.reduce((t, [re, rep]) => t.replace(re, rep), s);

function verdictOf(fileTrim: string, searchTrim: string): LineVerdict {
  if (fileTrim === searchTrim) return "match";
  if (collapseWs(fileTrim) === collapseWs(searchTrim)) return "ws-only";
  return "differ";
}

/** 最初に異なるコードポイントの位置と内容 (前後空白は無視して比較) */
function describeFirstDiff(fileLine: string, searchLine: string): string {
  const a = [...fileLine.trim()];
  const b = [...searchLine.trim()];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cp = (arr: string[], idx: number): string => {
    const ch = arr[idx];
    if (ch === undefined) return "行末";
    return `U+${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;
  };
  return `${i + 1} 文字目から異なります (実ファイル側: ${cp(a, i)} / SEARCH 側: ${cp(b, i)})`;
}

function noteFor(fileLine: string, searchLine: string, verdict: LineVerdict): string | undefined {
  if (verdict === "ws-only") {
    return "行内の連続空白の個数のみが異なります (実ファイル側の行をそのままコピーしてください)";
  }
  if (verdict === "differ") {
    const ft = fileLine.trim();
    const st = searchLine.trim();
    if (collapseWs(foldConfusable(ft)) === collapseWs(foldConfusable(st))) {
      return `見た目で区別しづらい文字の差です。${describeFirstDiff(fileLine, searchLine)}`;
    }
  }
  return undefined;
}

/**
 * SEARCH に最も近い実ファイル領域を探す。
 * スコア: 前後空白無視の一致 = 3 点、空白圧縮一致 = 2 点、不可視文字の畳み込みまで
 * かけて一致 = 1 点。最高得点の最初の位置を採用する (全比較段が 0 のときのみ null)。
 * 走査が O(ファイル行数 × SEARCH 行数) になるため、正規化はすべて事前計算する。
 */
export function analyzeNearest(
  fileLines: string[],
  search: string[],
  afterPriorBlocks = false,
): NearestAnalysis {
  const fTrim = fileLines.map((l) => l.trim());
  const sTrim = search.map((l) => l.trim());
  const fColl = fTrim.map(collapseWs);
  const sColl = sTrim.map(collapseWs);
  const fFold = fTrim.map((t) => collapseWs(foldConfusable(t)));
  const sFold = sTrim.map((t) => collapseWs(foldConfusable(t)));

  const lineHits: LineHit[] = [];
  search.forEach((text, i) => {
    const t = sTrim[i] as string;
    if (t === "") return; // 空行はどこにでも一致するため対象外
    let count = 0;
    for (const f of fTrim) if (f === t) count++;
    lineHits.push({ index: i + 1, text, count });
  });

  const size = Math.min(search.length, fileLines.length);
  let bestStart = -1;
  let bestScore = 0;
  let bestMatch = 0;
  for (let i = 0; size > 0 && i + size <= fileLines.length; i++) {
    let score = 0;
    let matches = 0;
    for (let j = 0; j < size; j++) {
      if (fTrim[i + j] === sTrim[j]) {
        score += 3;
        matches++;
      } else if (fColl[i + j] === sColl[j]) {
        score += 2;
      } else if (fFold[i + j] === sFold[j]) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestMatch = matches;
    }
  }

  if (bestStart < 0) return { lineHits, window: null, afterPriorBlocks };

  const lines: WindowLine[] = [];
  const from = Math.max(0, bestStart - CONTEXT_LINES);
  const to = Math.min(fileLines.length, bestStart + size + CONTEXT_LINES);
  for (let i = from; i < to; i++) {
    const inWindow = i >= bestStart && i < bestStart + size;
    if (!inWindow) {
      lines.push({ lineNo: i + 1, text: fileLines[i] as string, verdict: null });
      continue;
    }
    const j = i - bestStart;
    const verdict = verdictOf(fTrim[i] as string, sTrim[j] as string);
    const note = noteFor(fileLines[i] as string, search[j] as string, verdict);
    lines.push({
      lineNo: i + 1,
      text: fileLines[i] as string,
      verdict,
      ...(note !== undefined ? { note } : {}),
    });
  }

  return {
    lineHits,
    window: { total: search.length, matchCount: bestMatch, lines },
    afterPriorBlocks,
  };
}

const MARK: Record<LineVerdict, string> = { match: "=", "ws-only": "~", differ: "!" };

/** 失敗レポートに埋め込む診断テキスト。抜粋行は「│」の右側が実ファイルの verbatim */
export function renderNearest(a: NearestAnalysis): string[] {
  const out: string[] = ["#### 参考: 実ファイルの該当箇所 (petari が現在のファイル内容から自動抽出)"];
  if (a.afterPriorBlocks) {
    out.push(
      "(同一ファイル内の先行ブロックを適用した後の想定内容です。SEARCH はこの内容に一致させてください)",
    );
  }
  out.push("");

  const missing = a.lineHits.filter((h) => h.count === 0);
  if (missing.length > 0) {
    out.push("SEARCH のうち実ファイルに存在しない行 (前後の空白は無視して照合):");
    for (const h of missing.slice(0, MAX_MISSING_LINES)) {
      out.push(`- SEARCH ${h.index} 行目: ${h.text.trim()}`);
    }
    if (missing.length > MAX_MISSING_LINES) {
      out.push(`- …他 ${missing.length - MAX_MISSING_LINES} 行`);
    }
  } else if (a.window !== null) {
    out.push("SEARCH の各行は実ファイル内に個別には存在しますが、この並びでは連続していません。");
  }

  if (a.window === null) {
    out.push(
      "",
      "SEARCH のどの行も (前後の空白を無視しても) 現在のファイルに見つかりません。",
      "changes.md の基準にしたスナップショット (repomix 等) が古いか、チャット側の要約・",
      "検索処理により実在しないコードを参照している可能性があります。推測で SEARCH を",
      "書き換えず、最新のファイル内容の共有を受けてから作り直してください。",
    );
    return out;
  }

  const w = a.window;
  out.push("", `最も近い領域 (SEARCH ${w.total} 行中 ${w.matchCount} 行が一致):`, "```");
  for (const line of w.lines.slice(0, MAX_RENDER_LINES)) {
    const mark = line.verdict === null ? " " : MARK[line.verdict];
    out.push(`${mark} ${String(line.lineNo).padStart(5)}│${line.text}`);
  }
  if (w.lines.length > MAX_RENDER_LINES) {
    out.push(`… (以下 ${w.lines.length - MAX_RENDER_LINES} 行省略)`);
  }
  out.push(
    "```",
    "凡例: ! = SEARCH と内容が異なる行 / ~ = 空白の個数のみ異なる行 / = = 一致した行 / 無印 = 前後の文脈",
  );
  for (const line of w.lines) {
    if (line.note !== undefined) out.push(`- ${line.lineNo} 行目: ${line.note}`);
  }
  return out;
}
