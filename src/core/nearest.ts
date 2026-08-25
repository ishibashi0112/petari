/**
 * SEARCH 不一致時の近傍診断 (§7 失敗レポートの拡充)。
 * 実ファイル内で SEARCH に最も近い領域を特定し、どの行がどう違うかを構造化して返す。
 * I/O を持たない純粋ロジック。レポートの文字列化は renderNearest が行う。
 *
 * 2026-08-25 の実運用事例 (AI が失敗原因を空白/エンコーディングと誤診し 4 往復) を受けて追加。
 * 抜粋行は verbatim で保持する — AI がそのまま次の SEARCH へコピーする前提のため、
 * 制御文字の可視化などの加工は行わない (差分の説明は note 側に分離する)。
 *
 * 2026-08-25 追記 (空行欠落事例): スナップショット生成ツール側で空行が落ち、SEARCH に
 * 空行が不足するだけで不一致になる事例が確認された。固定幅ウィンドウのスライド照合では
 * 1 行の過不足で位置合わせ全体がずれ、別の類似箇所 (End Sub 等) を抜粋してしまうため、
 * ギャップ (行の挿入・欠落) を許容するアラインメント (fit alignment) へ変更した。
 * 実ファイル側にだけある行は "+" として抜粋に含め、空行なら専用の注記と修正ヒントを出す。
 */

/** ウィンドウ内の 1 行と SEARCH 対応行の照合結果。extra = 実ファイル側にだけある行 */
export type LineVerdict = "match" | "ws-only" | "differ" | "extra";

/** 診断の照合対象。通常は SEARCH。SEARCH が全滅のとき REPLACE 側でも近傍推定する */
export type NearestSubject = "SEARCH" | "REPLACE";

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
  /** 不一致行の補足説明 (空行の欠落・空白の個数差・不可視文字の差など) */
  note?: string;
}

/** アラインメントの結果、この領域に対応する行が無かった SEARCH 側の行 */
export interface UnmatchedSearchLine {
  /** SEARCH 内の行番号 (1-based) */
  index: number;
  text: string;
  blank: boolean;
}

export interface NearestWindow {
  /** SEARCH の行数 */
  total: number;
  /** ウィンドウ内で一致 (前後空白無視) した行数 */
  matchCount: number;
  lines: WindowLine[];
  /** 実ファイル側にあり SEARCH に無い行 (verdict: extra) の数 */
  extraCount: number;
  /** extra のうち空行の数 (空行欠落の名指し診断に使う) */
  extraBlankCount: number;
  /** SEARCH 側にあり、この領域に対応が無かった行 */
  unmatchedSearch: UnmatchedSearchLine[];
}

export interface NearestAnalysis {
  /** SEARCH 各行 (空行を除く) の実ファイル内での出現数 */
  lineHits: LineHit[];
  /** 最も一致行数の多い領域。1 行も (不可視文字の畳み込みでも) 一致しなければ null */
  window: NearestWindow | null;
  /** 同一ファイル内の先行ブロック適用後の行配列を基準にしているか */
  afterPriorBlocks: boolean;
  /** 照合対象 (注記の文言に使う)。通常は SEARCH */
  subject: NearestSubject;
}

/** 前後のコンテキストとして抜粋に含める行数 */
const CONTEXT_LINES = 4;
/** レポートに載せるウィンドウの最大行数 (巨大 SEARCH の暴走防止) */
const MAX_RENDER_LINES = 40;
/** 「存在しない行」一覧の最大表示数 */
const MAX_MISSING_LINES = 8;
/** アラインメント DP のセル数上限 (巨大ファイル × 巨大 SEARCH のメモリ暴走防止) */
const MAX_DP_CELLS = 20_000_000;

/**
 * アラインメントのスコア。置換 (SUB) は gap 2 個 (削除+挿入) より高くする —
 * 内容の異なる行同士でも位置が対応するなら「!」として同じ行に並べて見せたいため。
 */
const SCORE_MATCH = 6; // 前後空白無視で一致
const SCORE_WS = 4; // 行内空白の圧縮まで許すと一致
const SCORE_FOLD = 2; // 不可視文字の畳み込みまで許すと一致
const SCORE_SUB = -2; // 内容の異なる行同士の対応付け
const GAP = -3; // 片側にしかない行 1 行あたり

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

function noteFor(
  fileLine: string,
  searchLine: string,
  verdict: LineVerdict,
  subject: NearestSubject,
): string | undefined {
  if (verdict === "ws-only") {
    return "行内の連続空白の個数のみが異なります (実ファイル側の行をそのままコピーしてください)";
  }
  if (verdict === "differ") {
    const ft = fileLine.trim();
    const st = searchLine.trim();
    if (ft === "" && st !== "") {
      return `実ファイル側のこの行は空行です。空行も 1 行として照合されるため、${subject} 側の空行の過不足を確認してください`;
    }
    if (st === "" && ft !== "") {
      return `${subject} 側の対応行は空行ですが、実ファイルのこの行は空行ではありません (${subject} 側の空行の位置を確認してください)`;
    }
    if (collapseWs(foldConfusable(ft)) === collapseWs(foldConfusable(st))) {
      return `見た目で区別しづらい文字の差です。${describeFirstDiff(fileLine, searchLine)}`;
    }
  }
  return undefined;
}

type AlignStep =
  | { kind: "pair"; fileIdx: number; searchIdx: number }
  | { kind: "extra"; fileIdx: number }
  | { kind: "missing"; searchIdx: number };

/**
 * fit alignment: SEARCH 全行を実ファイルのどこかの連続領域に、行の挿入・欠落 (gap) を
 * 許容しつつ最良スコアで対応付ける。局所アラインメントと違い SEARCH 側は必ず全行を
 * 消費する (先頭・末尾の不一致行も「!」として抜粋に残すため)。
 * 実ファイル側の開始位置は自由 (H[i][0] = 0)、同点なら最初 (最も上) の領域を採用。
 */
function alignSearch(
  fTrim: string[],
  sTrimAll: string[],
  fColl: string[],
  sCollAll: string[],
  fFold: string[],
  sFoldAll: string[],
): { steps: AlignStep[]; clippedSearchFrom: number } | null {
  const n = fTrim.length;
  if (n === 0 || sTrimAll.length === 0) return null;
  // セル数上限を超える場合は SEARCH 側を先頭から切り詰める (残りは unmatched 扱い)
  const m = Math.min(sTrimAll.length, Math.max(1, Math.floor(MAX_DP_CELLS / n)));

  const pairScore = (fi: number, sj: number): number => {
    if (fTrim[fi] === sTrimAll[sj]) return SCORE_MATCH;
    if (fColl[fi] === sCollAll[sj]) return SCORE_WS;
    if (fFold[fi] === sFoldAll[sj]) return SCORE_FOLD;
    return SCORE_SUB;
  };

  // 1 = diag (pair), 2 = up (実ファイル側の挿入行), 3 = left (SEARCH 側の欠落行)
  const dirs = new Uint8Array(n * m);
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 1; j <= m; j++) prev[j] = j * GAP;

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestI = -1;
  for (let i = 1; i <= n; i++) {
    curr[0] = 0;
    for (let j = 1; j <= m; j++) {
      const diag = (prev[j - 1] as number) + pairScore(i - 1, j - 1);
      const up = (prev[j] as number) + GAP;
      const left = (curr[j - 1] as number) + GAP;
      let v = diag;
      let d = 1;
      if (up > v) {
        v = up;
        d = 2;
      }
      if (left > v) {
        v = left;
        d = 3;
      }
      curr[j] = v;
      dirs[(i - 1) * m + (j - 1)] = d;
    }
    if ((curr[m] as number) > bestScore) {
      bestScore = curr[m] as number;
      bestI = i;
    }
    [prev, curr] = [curr, prev];
  }
  if (bestI < 0) return null;

  const rev: AlignStep[] = [];
  let i = bestI;
  let j = m;
  while (j > 0) {
    if (i === 0) {
      rev.push({ kind: "missing", searchIdx: j - 1 });
      j--;
      continue;
    }
    const d = dirs[(i - 1) * m + (j - 1)];
    if (d === 1) {
      rev.push({ kind: "pair", fileIdx: i - 1, searchIdx: j - 1 });
      i--;
      j--;
    } else if (d === 2) {
      rev.push({ kind: "extra", fileIdx: i - 1 });
      i--;
    } else {
      rev.push({ kind: "missing", searchIdx: j - 1 });
      j--;
    }
  }
  return { steps: rev.reverse(), clippedSearchFrom: m };
}

/**
 * SEARCH に最も近い実ファイル領域を探す。
 * 行の対応付けはギャップ許容アラインメント (alignSearch)。1 行も (空白圧縮・不可視文字の
 * 畳み込みでも) 一致しないときのみ window は null。
 */
export function analyzeNearest(
  fileLines: string[],
  search: string[],
  afterPriorBlocks = false,
  subject: NearestSubject = "SEARCH",
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

  const aligned = alignSearch(fTrim, sTrim, fColl, sColl, fFold, sFold);
  if (aligned === null) return { lineHits, window: null, afterPriorBlocks, subject };
  const { steps, clippedSearchFrom } = aligned;

  // どの段の一致も 1 行も無いアラインメントは領域として無意味 (従来の null 条件を維持)
  const anyHit = steps.some(
    (s) =>
      s.kind === "pair" &&
      (fTrim[s.fileIdx] === sTrim[s.searchIdx] ||
        fColl[s.fileIdx] === sColl[s.searchIdx] ||
        fFold[s.fileIdx] === sFold[s.searchIdx]),
  );
  if (!anyHit) return { lineHits, window: null, afterPriorBlocks, subject };

  const fileIdxs = steps.flatMap((s) => (s.kind === "missing" ? [] : [s.fileIdx]));
  const startFile = Math.min(...fileIdxs);
  const endFile = Math.max(...fileIdxs) + 1;

  const lines: WindowLine[] = [];
  const unmatchedSearch: UnmatchedSearchLine[] = [];
  let matchCount = 0;
  let extraCount = 0;
  let extraBlankCount = 0;

  const pushContext = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      lines.push({ lineNo: i + 1, text: fileLines[i] as string, verdict: null });
    }
  };

  pushContext(Math.max(0, startFile - CONTEXT_LINES), startFile);
  for (const step of steps) {
    if (step.kind === "missing") {
      unmatchedSearch.push({
        index: step.searchIdx + 1,
        text: search[step.searchIdx] as string,
        blank: sTrim[step.searchIdx] === "",
      });
      continue;
    }
    if (step.kind === "extra") {
      extraCount++;
      const blank = fTrim[step.fileIdx] === "";
      if (blank) extraBlankCount++;
      const note = blank
        ? `実ファイル側にある空行です。${subject} にこの空行が欠けているため一致しませんでした (空行も 1 行として照合されます)`
        : `${subject} に含まれていない行です。この行も含めてコピーしてください`;
      lines.push({
        lineNo: step.fileIdx + 1,
        text: fileLines[step.fileIdx] as string,
        verdict: "extra",
        note,
      });
      continue;
    }
    const verdict = verdictOf(fTrim[step.fileIdx] as string, sTrim[step.searchIdx] as string);
    if (verdict === "match") matchCount++;
    const note = noteFor(
      fileLines[step.fileIdx] as string,
      search[step.searchIdx] as string,
      verdict,
      subject,
    );
    lines.push({
      lineNo: step.fileIdx + 1,
      text: fileLines[step.fileIdx] as string,
      verdict,
      ...(note !== undefined ? { note } : {}),
    });
  }
  pushContext(endFile, Math.min(fileLines.length, endFile + CONTEXT_LINES));

  // DP セル数上限で切り詰めた SEARCH 末尾は対応なし扱い
  for (let k = clippedSearchFrom; k < search.length; k++) {
    unmatchedSearch.push({ index: k + 1, text: search[k] as string, blank: sTrim[k] === "" });
  }

  return {
    lineHits,
    window: {
      total: search.length,
      matchCount,
      lines,
      extraCount,
      extraBlankCount,
      unmatchedSearch,
    },
    afterPriorBlocks,
    subject,
  };
}

const MARK: Record<LineVerdict, string> = { match: "=", "ws-only": "~", differ: "!", extra: "+" };

/** 抜粋 (コードブロック + 凡例 + 行ごとの注記)。SEARCH / REPLACE 両方の診断で共用 */
function renderWindowBody(w: NearestWindow, subject: NearestSubject): string[] {
  const out: string[] = ["```"];
  for (const line of w.lines.slice(0, MAX_RENDER_LINES)) {
    const mark = line.verdict === null ? " " : MARK[line.verdict];
    out.push(`${mark} ${String(line.lineNo).padStart(5)}│${line.text}`);
  }
  if (w.lines.length > MAX_RENDER_LINES) {
    out.push(`… (以下 ${w.lines.length - MAX_RENDER_LINES} 行省略)`);
  }
  out.push(
    "```",
    `凡例: ! = ${subject} と内容が異なる行 / ~ = 空白の個数のみ異なる行 / + = 実ファイルにあるが ${subject} にない行 / = = 一致した行 / 無印 = 前後の文脈`,
  );
  for (const line of w.lines) {
    if (line.note !== undefined) out.push(`- ${line.lineNo} 行目: ${line.note}`);
  }
  for (const u of w.unmatchedSearch) {
    out.push(
      u.blank
        ? `- ${subject} ${u.index} 行目の空行に対応する行がこの領域にありません (${subject} 側の空行が余分の可能性)`
        : `- ${subject} ${u.index} 行目 (${u.text.trim()}) に対応する行がこの領域にありません`,
    );
  }
  return out;
}

/**
 * 修正のヒント (near-miss 自動サジェスト)。SEARCH の全行が順序どおり実ファイルに存在し、
 * 間に SEARCH 側に無い行が挟まっているだけなら「抜粋のコピーで一致する」と機械的に言える。
 * 全部が空行なら空行欠落を名指しする (2026-08-25 の実運用事例の直接対策)。
 */
function buildHint(w: NearestWindow): string[] {
  if (w.extraCount === 0 || w.unmatchedSearch.length > 0) return [];
  if (w.lines.some((l) => l.verdict === "differ")) return [];
  const head =
    w.extraBlankCount === w.extraCount
      ? `▶ 修正のヒント: SEARCH の全行はこの順で実ファイルに存在しますが、間に空行 ${w.extraCount} 行が挟まっています。空行も 1 行として照合されるため一致しませんでした。`
      : `▶ 修正のヒント: SEARCH の全行はこの順で実ファイルに存在しますが、間に SEARCH にない行が ${w.extraCount} 行 (うち空行 ${w.extraBlankCount} 行) 挟まっています。`;
  return [
    "",
    head,
    "上の抜粋の「│」より右側を、+ の行も含めてそのままコピーした SEARCH に置き換えれば一致します。",
  ];
}

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
  out.push("", `最も近い領域 (SEARCH ${w.total} 行中 ${w.matchCount} 行が一致):`);
  out.push(...renderWindowBody(w, a.subject));
  out.push(...buildHint(w));
  return out;
}

/**
 * SEARCH がどの行も見つからなかったときの補助診断: REPLACE 側の内容に近い実ファイル領域。
 * 「本来変更を当てたかった箇所」の推定と、変更が既に別の形で入っている可能性の提示に使う。
 */
export function renderNearestReplace(a: NearestAnalysis): string[] {
  if (a.window === null) return [];
  const w = a.window;
  return [
    "#### 参考: REPLACE 側の内容に近い実ファイル領域",
    "(SEARCH はどの行も見つかりませんでしたが、REPLACE の内容に近い箇所が実ファイルにあります。",
    "この変更が既に別の形で適用されているか、SEARCH の基準にしたスナップショットが古い可能性が",
    "あります。変更がまだ必要な場合は、以下の抜粋を現在の内容として SEARCH を作り直してください)",
    "",
    `最も近い領域 (REPLACE ${w.total} 行中 ${w.matchCount} 行が一致):`,
    ...renderWindowBody(w, a.subject),
  ];
}
