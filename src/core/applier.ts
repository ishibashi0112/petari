/**
 * ChangeSet の検証と適用計画 (§4.1 手順 1-3, §9)。
 * I/O を持たない純粋層: ファイル状態 (FileState) を受け取り、
 * 書き込むべきバイト列と失敗一覧を返す。実際の読み書きは commands/ が行う。
 */
import type { ChangeSet, FileChange, ReplaceBlock } from "../types.ts";
import {
  EncodingError,
  decodeFile,
  encodeDocument,
  findUnencodable,
  makeDocument,
  type DocLine,
  type Eol,
  type FileEncoding,
} from "./encoding.ts";
import {
  STAGE_LABEL,
  contentEqualsStage,
  findContentStage,
  findInsertionPresenceStage,
  matchBlock,
  type MatchStage,
  type PresenceStage,
} from "./matcher.ts";
import {
  MASK_TOKEN,
  hasMaskToken,
  maskLinesForDisplay,
  maskedValueCounts,
  maskedViews,
  restoreMaskedLines,
  type MaskRestoreResult,
  type MaskedLine,
} from "./mask.ts";
import { analyzeNearest, type NearestAnalysis } from "./nearest.ts";

export interface NewFileConfig {
  encoding: FileEncoding;
  bom?: boolean;
  eol: Eol;
}

/** 適用前のファイル状態 (commands 層が lstat / read して渡す) */
export interface FileState {
  exists: boolean;
  symlink: boolean;
  bytes: Uint8Array | null;
  /** パスが symlink ディレクトリ経由でプロジェクトルートの外を指している (§9) */
  escapesRoot?: boolean;
}

export type FailureKind =
  | "path-invalid"
  | "symlink"
  | "target-missing"
  | "target-exists"
  | "undecodable"
  | "block-not-found"
  | "block-ambiguous"
  | "unencodable"
  | "masked-value";

export interface Failure {
  path: string;
  kind: FailureKind;
  message: string;
  /** ブロック起因の失敗のとき、そのブロック */
  block?: ReplaceBlock;
  /** block-not-found のとき: 実ファイル内で最も近い箇所の診断 (§7 レポートに掲載) */
  nearest?: NearestAnalysis;
  /**
   * SEARCH がどの行も見つからなかったとき: REPLACE 側の内容で推定した近傍診断。
   * 「本来当てたかった箇所」の提示と、変更が既に別の形で入っている可能性の診断材料
   */
  nearestReplace?: NearestAnalysis;
  /** masked-value のとき: --literal-masked の指定があったが、実際の値を伏せた行がある範囲のため使わなかった */
  literalRefused?: boolean;
  /** masked-value のとき: --literal-masked を指定すれば [MASKED] の文字のまま書ける (案内用) */
  literalAllowed?: boolean;
}

/** 適用に成功した replace ブロックの記録 (差分プレビューと manifest 用) */
export interface AppliedBlockInfo {
  block: ReplaceBlock;
  stage: MatchStage;
  /** 適用直前の行配列に対するマッチ開始位置 (0-based) */
  start: number;
  removed: string[];
  inserted: string[];
  /** 伏せ字 [MASKED] を元の値に戻した数 (SEARCH を伏せた表示で照合したブロックなど) */
  restoredMasks?: number;
  /** --literal-masked で [MASKED] の文字のまま書いた数 */
  literalMasks?: number;
}

/** REPLACE が既にファイル内に存在したためスキップしたブロック (冪等性・成功扱い) */
export interface AlreadyAppliedBlock {
  block: ReplaceBlock;
  stage: PresenceStage;
  /** 追記型: SEARCH は一致したが、追記する行がその前後に既にあった (§6.1) */
  insertion?: true;
}

export interface FileOutcome {
  change: FileChange;
  failures: Failure[];
  /** 書き込むバイト列。delete と「書き込み不要 (失敗/全ブロック失敗/適用済み)」は null */
  afterBytes: Uint8Array | null;
  appliedBlocks: AppliedBlockInfo[];
  /** 適用済みとしてスキップしたブロック (replace のみ) */
  alreadyAppliedBlocks: AlreadyAppliedBlock[];
  /**
   * ファイル全体が既に適用後の状態で、書き込み不要 (成功扱い)。
   * replace: 全ブロック適用済み / rewrite・create: 内容一致 / delete: 既に存在しない
   */
  alreadyApplied: boolean;
  totalBlocks: number;
  /** rewrite で伏せ字 [MASKED] を元の値に戻した数 (replace はブロックごとに記録) */
  restoredMasks?: number;
  /** rewrite / create で --literal-masked により [MASKED] の文字のまま書いた数 */
  literalMasks?: number;
}

export interface Plan {
  outcomes: FileOutcome[];
  /** 全ファイルの失敗を平坦化したもの */
  failures: Failure[];
  /** 失敗ゼロなら true (all-or-nothing 判定・§4.1) */
  ok: boolean;
}

/** Windows の予約デバイス名 (拡張子付きも不可) */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..+)?$/i;

/** §9: プロジェクトルート相対のみ。絶対パス・`..`・`~`・Windows 特殊パスを拒否 */
export function invalidPathReason(path: string): string | null {
  if (path.trim() === "") return "パスが空です";
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:/.test(path)) {
    return "絶対パスは使えません (プロジェクトルート相対で指定してください)";
  }
  if (path.includes(":")) return "':' を含むパスは使えません (Windows の代替データストリーム対策)";
  const segments = path.split("/");
  if (segments.includes("..")) return "'..' を含むパスは使えません";
  if (path.startsWith("~")) return "'~' で始まるパスは使えません";
  // Windows は末尾のドット/空白を無視して解釈するため、除去してから予約名判定する
  if (segments.some((s) => WINDOWS_RESERVED.test(s.replace(/[. ]+$/, "")))) {
    return "Windows の予約デバイス名 (CON, NUL, COM1 等) を含むパスは使えません";
  }
  return null;
}

function fileFailure(change: FileChange, kind: FailureKind, message: string): FileOutcome {
  return {
    change,
    failures: [{ path: change.path, kind, message }],
    afterBytes: null,
    appliedBlocks: [],
    alreadyAppliedBlocks: [],
    alreadyApplied: false,
    totalBlocks: change.op === "replace" ? change.blocks.length : 0,
  };
}

export interface PlanOptions {
  /**
   * 元の値に戻せない [MASKED] を、その文字のまま書き込む (--literal-masked)。
   * 伏せ字を扱うコードそのもの (ログを伏せる処理など) を書く場合の明示の指定
   */
  literalMasked?: boolean;
}

/** 伏せ字を戻せなかったときの説明 (失敗レポートとして AI に貼られる前提の文面) */
function maskFailureMessage(prefix: string, r: MaskRestoreResult & { ok: false }): string {
  const shown = r.failures.slice(0, 5).map((f) => {
    const what =
      f.reason === "ambiguous" ? "同じ表示の伏せ字の行が複数あり、どの値か決まりません" : "伏せる前の同じ行が見つかりません";
    return `「${f.line.trim()}」(${what})`;
  });
  const more = r.failures.length > 5 ? ` 他 ${r.failures.length - 5} 行` : "";
  return (
    `${prefix}伏せ字 ${MASK_TOKEN} を元の値に戻せないため書き込めません: ${shown.join("、")}${more}。` +
    `${MASK_TOKEN} は実際の値を伏せた印で、petari が元の値に戻せるのは、伏せ字を含む行を一字も変えずに残したときだけです。` +
    `伏せ字を含む行は SEARCH にも REPLACE にもそのまま写してください。伏せ字を含む行を書き換える・新しく足す・` +
    `コメントなどに ${MASK_TOKEN} と書く変更はできません (その行は変えずに残し、利用者に手で直してもらうよう説明してください)`
  );
}

type BlockMatch = ReturnType<typeof matchBlock>;

/**
 * 抜粋の行のうち、複数行にまたがる値を伏せた範囲にかかる行に印を付ける。印を付けるのは SEARCH に
 * 対応づけた行 (前後の文脈は写す対象ではない) だけで、その行を写した SEARCH に伏せ字が入るとき
 * だけ (伏せ字のない SEARCH は実ファイルで照合するため、その行を含めても一致する)
 */
function markWrapped(a: NearestAnalysis, isWrapped: (lineNo: number) => boolean): NearestAnalysis {
  if (a.window === null) return a;
  const aligned = a.window.lines.filter((l) => l.verdict !== null);
  if (!aligned.some((l) => hasMaskToken(l.text))) return a;
  const lines = a.window.lines.map((l) =>
    l.verdict !== null && isWrapped(l.lineNo) ? { ...l, wrapped: true } : l,
  );
  return { ...a, window: { ...a.window, lines } };
}

/** 行番号の一覧を「3〜5, 9」の形にする */
function formatLineRanges(lineNos: number[]): string {
  const sorted = [...new Set(lineNos)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}〜${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * 伏せた表示ごとに照合する (SEARCH の [MASKED] は slnmix のパックから写した行)。
 * どれかの表示で複数一致する・表示によって一致する位置が違うときは ambiguous
 * (伏せた値の違いでしか区別できない)。複数行にまたがる値を伏せた行を含む一致は採らない
 * (パックではその行の見え方が違うため、AI が写した行とは本来一致しない)。どれでも一致しなければ null
 */
function matchOnViews(views: MaskedLine[][], block: ReplaceBlock): BlockMatch | null {
  const found: (BlockMatch & { ok: true })[] = [];
  for (const view of views) {
    const r = matchBlock(
      view.map((l) => l.text),
      block,
    );
    if (r.ok) {
      if (!view.slice(r.start, r.end).some((l) => l.wrapped)) found.push(r);
    } else if (r.reason === "ambiguous") {
      return r;
    }
  }
  const first = found[0];
  if (first === undefined) return null;
  if (found.some((r) => r.start !== first.start || r.end !== first.end)) {
    const positions = [...new Set(found.map((r) => r.start))].sort((a, b) => a - b);
    return { ok: false, block, reason: "ambiguous", stage: first.stage, count: positions.length, positions };
  }
  return first;
}

/** rewrite / create / delete がファイル単位で適用済みだったときの成功 outcome */
function fileAlreadyApplied(change: FileChange): FileOutcome {
  return {
    change,
    failures: [],
    afterBytes: null,
    appliedBlocks: [],
    alreadyAppliedBlocks: [],
    alreadyApplied: true,
    totalBlocks: 0,
  };
}

function planReplace(
  change: FileChange & { op: "replace" },
  state: FileState,
  fallbackEol: Eol,
  options: PlanOptions,
): FileOutcome {
  let doc;
  try {
    doc = decodeFile(state.bytes as Uint8Array);
  } catch (e) {
    return fileFailure(
      change,
      "undecodable",
      e instanceof EncodingError ? e.message : String(e),
    );
  }

  const failures: Failure[] = [];
  const applied: AppliedBlockInfo[] = [];
  const already: AlreadyAppliedBlock[] = [];
  let docLines: DocLine[] = doc.lines;
  let textLines: string[] = docLines.map((l) => l.text);
  const original = textLines;
  const literal = options.literalMasked === true;
  // 伏せた表示 (行の位置は今の行配列と同じ)。照合・復元用 (伏せ方ごと) と失敗レポートの抜粋用。
  // 伏せる処理は元のファイルにだけかける (AI が見たパックは元のファイルから作られている。先のブロックで
  // 前後の行が変わると伏せなくなる値 (行継続の代入など) も、伏せたまま扱う)。各行が元のファイルの
  // どの行と同じ内容か (provenance) を持ち、その行の伏せた表示を使う。この計画で新しく書いた行は
  // AI の書いた行そのもの (伏せ字なし)
  let origViews: MaskedLine[][] | null = null;
  const originalViews = (): MaskedLine[][] => (origViews ??= maskedViews(original, change.path));
  let origDisplay: string[] | null = null;
  const originalDisplay = (): string[] =>
    (origDisplay ??= maskLinesForDisplay(original, { path: change.path }));
  let provenance: (number | null)[] = original.map((_, i) => i);
  let changed = false;
  const sameIndent = (line: string, masked: string): string =>
    `${/^\s*/.exec(line)?.[0] ?? ""}${masked.trim()}${/\s*$/.exec(line.trimStart())?.[0] ?? ""}`;
  let viewsCache: MaskedLine[][] | null = null;
  const views = (): MaskedLine[][] =>
    (viewsCache ??= !changed
      ? originalViews()
      : originalViews().map((view) =>
          textLines.map((text, i): MaskedLine => {
            const p = provenance[i];
            const src = p === null || p === undefined ? undefined : view[p];
            // この計画で書いた行の伏せ字は、--literal-masked で書いた [MASKED] という文字そのもの
            if (p === null || p === undefined || src === undefined) {
              return { text, values: text.split(MASK_TOKEN).slice(1).map(() => MASK_TOKEN), wrapped: false };
            }
            return text === original[p] ? src : { ...src, text: sameIndent(text, src.text) };
          }),
        ));
  let displayCache: string[] | null = null;
  const display = (): string[] =>
    (displayCache ??= !changed
      ? originalDisplay()
      : textLines.map((text, i) => {
          const p = provenance[i];
          const src = p === null || p === undefined ? undefined : originalDisplay()[p];
          if (p === null || p === undefined || src === undefined) return text;
          return text === original[p] ? src : sameIndent(text, src);
        }));
  /** 伏せ字の行の表示 (前後の空白を除く) ごとの元の値の組の数。2 以上なら値の違いでしか区別できない */
  const valueSetsOf = (key: string): number => {
    const sets = new Set<string>();
    for (const view of views()) {
      for (const l of view) if (l.text.trim() === key) sets.add(JSON.stringify(l.values));
    }
    return sets.size;
  };

  for (const block of change.blocks) {
    let m: BlockMatch = matchBlock(textLines, block);
    if (block.search.some(hasMaskToken) && (m.ok || m.reason === "not-found")) {
      // SEARCH の [MASKED] は伏せた表示となら一致する (slnmix のパックから写した行)。実ファイルで
      // 一致しても (もともと [MASKED] という文字の行)、伏せると同じに見える別の箇所があれば ambiguous
      const byViews = matchOnViews(views(), block);
      if (!m.ok) {
        m = byViews ?? m;
      } else if (byViews !== null && (!byViews.ok || byViews.start !== m.start || byViews.end !== m.end)) {
        const positions = [
          ...new Set([m.start, ...(byViews.ok ? [byViews.start] : (byViews.positions ?? []))]),
        ].sort((a, b) => a - b);
        m = { ok: false, block, reason: "ambiguous", stage: m.stage, count: positions.length, positions };
      }
    }
    if (!m.ok) {
      // 冪等性 (§6): SEARCH 不一致でも REPLACE がまるごと存在すれば「適用済み」として
      // 成功扱いでスキップする (書き込みなし)。空・空行のみの REPLACE は判定対象外
      if (m.reason === "not-found") {
        // 伏せ字を含む REPLACE は伏せた表示で探す。別の値の箇所を「済み」と取り違えないよう一意のときだけ
        // さらに、伏せ字の行が値の違う同じ表示の行と区別できるときだけ (伏せると同じに見える別の箇所に
        // 当たった変更を「済み」にしない)
        const byViews = (): PresenceStage | null => {
          const r = matchOnViews(views(), { ...block, search: block.replace });
          // 空行の差だけを吸収した一致は「済み」にしない (伏せ字のない REPLACE の判定と同じ)
          if (r?.ok !== true || r.stage === "blank-insensitive") return null;
          const distinct = block.replace.filter(hasMaskToken).every((l) => valueSetsOf(l.trim()) <= 1);
          return distinct ? r.stage : null;
        };
        const stage = block.replace.some(hasMaskToken)
          ? byViews()
          : findContentStage(textLines, block.replace);
        if (stage !== null) {
          already.push({ block, stage });
          continue;
        }
      }
      if (m.reason === "ambiguous") {
        // 位置は同一ファイル内の先行ブロック適用後の行配列に対する行番号 (通常は実ファイルと一致)
        const positions = (m.positions ?? []).map((p) => `${p + 1}`);
        const shown =
          positions.length > 5
            ? `${positions.slice(0, 5).join(", ")} 行目 他 ${positions.length - 5} 箇所`
            : `${positions.join(", ")} 行目`;
        failures.push({
          path: change.path,
          kind: "block-ambiguous",
          message: `ブロック ${block.index}: SEARCH が ${m.count} 箇所にマッチしました (${STAGE_LABEL[m.stage as MatchStage]}: ${shown})。前後の行を追加して一意に特定できる範囲にしてください`,
          block,
        });
        continue;
      }
      const checkedReplace = block.replace.some((l) => l.trim() !== "");
      const message =
        `ブロック ${block.index}: SEARCH が現在のファイル内容に見つかりません` +
        (checkedReplace
          ? " (REPLACE の内容も見つからないため、changes.md の基準スナップショットが現在のコードベースとずれている可能性があります)"
          : "");
      // 抜粋は AI に貼られるため、伏せた表示から作る (実際の値を載せない)
      const nearest = analyzeNearest(display(), block.search, applied.length > 0);
      // SEARCH が全滅のときのみ REPLACE 側で近傍を推定する (本来当てたかった箇所のヒント)。
      // fold 段のみの偶然一致をノイズとして弾くため matchCount >= 1 を要求する
      let nearestReplace: NearestAnalysis | undefined;
      if (nearest.window === null && checkedReplace) {
        const byReplace = analyzeNearest(display(), block.replace, applied.length > 0, "REPLACE");
        if (byReplace.window !== null && byReplace.window.matchCount >= 1) {
          nearestReplace = byReplace;
        }
      }
      // 複数行にまたがる値を伏せた範囲にかかる行は、SEARCH に含めると一致しない (パックでは 1 行にまとめて
      // 見えるため、一致に含めない)。抜粋をそのまま写して同じ失敗を繰り返さないよう、その行を名指しし、
      // 抜粋の注記・修正のヒントでも写すよう勧めない
      const isWrapped = (lineNo: number): boolean => views().some((view) => view[lineNo - 1]?.wrapped === true);
      const marked = markWrapped(nearest, isWrapped);
      const markedReplace = nearestReplace === undefined ? undefined : markWrapped(nearestReplace, isWrapped);
      const wrappedLines = [marked, markedReplace].flatMap((a) =>
        (a?.window?.lines ?? []).filter((l) => l.wrapped === true).map((l) => l.lineNo),
      );
      failures.push({
        path: change.path,
        kind: "block-not-found",
        message:
          wrappedLines.length > 0
            ? `${message}。抜粋の ${formatLineRanges(wrappedLines)} 行目は複数行にまたがる値 (秘密鍵の本文など) を伏せた` +
              "範囲にかかる行で、SEARCH に含めると一致しません。その行を含まない連続した範囲 (その行より前か後ろの行) で" +
              "一意に特定してください"
            : message,
        block,
        nearest: marked,
        ...(markedReplace !== undefined ? { nearestReplace: markedReplace } : {}),
      });
      continue;
    }
    let replacement = m.replacement as string[];
    let restoredMasks = 0;
    let literalMasks = 0;
    let sources: (number | null)[] = replacement.map(() => null);
    if (replacement.some(hasMaskToken)) {
      // 伏せ字のまま書くと実際の値が消える。SEARCH の範囲の同じ行から元の値に戻し、戻せなければ止める
      const r = restoreMaskedLines(replacement, views(), { from: m.start, to: m.end }, { literal });
      if (!r.ok) {
        failures.push({
          path: change.path,
          kind: "masked-value",
          message: maskFailureMessage(`ブロック ${block.index}: `, r),
          block,
          ...(r.literalRefused ? { literalRefused: true } : {}),
          ...(r.literalAllowed ? { literalAllowed: true } : {}),
        });
        continue;
      }
      replacement = r.lines;
      restoredMasks = r.restored;
      literalMasks = r.literal;
      sources = r.sources;
    }
    // 冪等性 (§6.1): 追記型ブロックは適用後も SEARCH が一致し続けるため、追記する行が
    // 一致範囲の前後に既にあれば「適用済み」としてスキップする (再実行での重複追記を防ぐ)
    const insertionStage = findInsertionPresenceStage(
      textLines,
      m.start,
      m.end,
      replacement === block.replace || restoredMasks > 0
        ? [replacement]
        : [replacement, block.replace],
    );
    if (insertionStage !== null) {
      already.push({ block, stage: insertionStage, insertion: true });
      continue;
    }
    const bad = findUnencodable(replacement.join("\n"), doc.encoding);
    if (bad.length > 0) {
      failures.push({
        path: change.path,
        kind: "unencodable",
        message: `ブロック ${block.index}: REPLACE 側に Shift_JIS へ変換できない文字が含まれています: ${bad.join(" ")}`,
        block,
      });
      continue;
    }
    applied.push({
      block,
      stage: m.stage,
      start: m.start,
      removed: textLines.slice(m.start, m.end),
      inserted: replacement,
      ...(restoredMasks > 0 ? { restoredMasks } : {}),
      ...(literalMasks > 0 ? { literalMasks } : {}),
    });
    // 書いた行の provenance: 元の値に戻した行は戻す元の行、SEARCH の範囲の行を (インデント以外)
    // そのまま残した行はその行。どちらでもなければ新しい行
    const from = m.start;
    const to = m.end;
    const newProvenance = replacement.map((line, j): number | null => {
      const source = sources[j];
      const candidates =
        source !== null && source !== undefined
          ? [source]
          : hasMaskToken(line)
            ? []
            : textLines.slice(from, to).flatMap((l, k) => (l.trim() === line.trim() ? [from + k] : []));
      for (const s of candidates) {
        const p = provenance[s];
        if (p !== null && p !== undefined && original[p]?.trim() === line.trim()) return p;
      }
      return null;
    });
    const newDocLines: DocLine[] = replacement.map((text) => ({ text, raw: null, eol: null }));
    docLines = [...docLines.slice(0, from), ...newDocLines, ...docLines.slice(to)];
    textLines = [...textLines.slice(0, from), ...replacement, ...textLines.slice(to)];
    provenance = [...provenance.slice(0, from), ...newProvenance, ...provenance.slice(to)];
    changed = true;
    viewsCache = null;
    displayCache = null;
  }

  const afterBytes =
    applied.length > 0 ? encodeDocument({ ...doc, lines: docLines }, fallbackEol) : null;
  return {
    change,
    failures,
    afterBytes,
    appliedBlocks: applied,
    alreadyAppliedBlocks: already,
    alreadyApplied:
      change.blocks.length > 0 && failures.length === 0 && already.length === change.blocks.length,
    totalBlocks: change.blocks.length,
  };
}

function planFile(
  change: FileChange,
  state: FileState,
  newFile: NewFileConfig,
  options: PlanOptions,
): FileOutcome {
  const pathReason = invalidPathReason(change.path);
  if (pathReason !== null) return fileFailure(change, "path-invalid", pathReason);
  if (state.escapesRoot === true) {
    return fileFailure(
      change,
      "path-invalid",
      "シンボリックリンクを経由してプロジェクトルートの外を指しています (§9)",
    );
  }
  if (state.symlink) {
    return fileFailure(change, "symlink", "シンボリックリンクは書き換え対象外です (§9)");
  }

  switch (change.op) {
    case "create": {
      if (state.exists) {
        // 冪等性: 既存ファイルの内容が CONTENT と一致するなら適用済みとしてスキップ
        if (state.bytes !== null) {
          try {
            const doc = decodeFile(state.bytes);
            if (contentEqualsStage(doc.lines.map((l) => l.text), change.content) !== null) {
              return fileAlreadyApplied(change);
            }
          } catch {
            // デコード不能なら判定せず従来のエラーへ
          }
        }
        return fileFailure(change, "target-exists", "create 指定ですがファイルが既に存在します (全文置き換えなら rewrite を使用)");
      }
      const maskedContent = change.content.filter(hasMaskToken);
      if (maskedContent.length > 0 && options.literalMasked !== true) {
        const outcome = fileFailure(
          change,
          "masked-value",
          maskFailureMessage("新規ファイルには元の値がありません。", {
            ok: false,
            failures: maskedContent.map((line) => ({ line, reason: "no-source" })),
            literalRefused: false,
            literalAllowed: true,
          }),
        );
        for (const f of outcome.failures) f.literalAllowed = true;
        return outcome;
      }
      const createLiteral = maskedContent.reduce((n, line) => n + line.split(MASK_TOKEN).length - 1, 0);
      const bad = findUnencodable(change.content.join("\n"), newFile.encoding);
      if (bad.length > 0) {
        return fileFailure(change, "unencodable", `新規ファイルの既定エンコーディング (${newFile.encoding}) に変換できない文字: ${bad.join(" ")}`);
      }
      const doc = makeDocument(change.content, newFile);
      return {
        change,
        failures: [],
        afterBytes: encodeDocument(doc),
        appliedBlocks: [],
        alreadyAppliedBlocks: [],
        alreadyApplied: false,
        totalBlocks: 0,
        ...(createLiteral > 0 ? { literalMasks: createLiteral } : {}),
      };
    }
    case "rewrite": {
      if (!state.exists) {
        return fileFailure(change, "target-missing", "rewrite 指定ですがファイルが存在しません (新規作成なら create を使用)");
      }
      let doc;
      try {
        doc = decodeFile(state.bytes as Uint8Array);
      } catch (e) {
        return fileFailure(change, "undecodable", e instanceof EncodingError ? e.message : String(e));
      }
      const current = doc.lines.map((l) => l.text);
      let content = change.content;
      let restoredMasks = 0;
      let literalMasks = 0;
      if (content.some(hasMaskToken)) {
        // 伏せ字は、現在のファイルの同じ行 (伏せた表示) から元の値に戻す
        const r = restoreMaskedLines(
          content,
          maskedViews(current, change.path),
          { from: 0, to: current.length },
          { literal: options.literalMasked === true },
        );
        if (!r.ok) {
          const outcome = fileFailure(change, "masked-value", maskFailureMessage("", r));
          for (const f of outcome.failures) {
            if (r.literalRefused) f.literalRefused = true;
            if (r.literalAllowed) f.literalAllowed = true;
          }
          return outcome;
        }
        content = r.lines;
        restoredMasks = r.restored;
        literalMasks = r.literal;
      }
      // 冪等性: 全文が現在の内容と一致するなら適用済みとしてスキップ
      if (contentEqualsStage(current, content) !== null) {
        return fileAlreadyApplied(change);
      }
      const bad = findUnencodable(content.join("\n"), doc.encoding);
      if (bad.length > 0) {
        return fileFailure(change, "unencodable", `Shift_JIS へ変換できない文字が含まれています: ${bad.join(" ")}`);
      }
      // 既存のエンコーディング・BOM・支配的 EOL・末尾改行の有無を維持して全文を差し替える (§8)
      const lines: DocLine[] = content.map((text) => ({ text, raw: null, eol: null }));
      const afterBytes = encodeDocument({ ...doc, lines });
      return {
        change,
        failures: [],
        afterBytes,
        appliedBlocks: [],
        alreadyAppliedBlocks: [],
        alreadyApplied: false,
        totalBlocks: 0,
        ...(restoredMasks > 0 ? { restoredMasks } : {}),
        ...(literalMasks > 0 ? { literalMasks } : {}),
      };
    }
    case "delete": {
      if (!state.exists) {
        // 冪等性: 既に存在しないなら適用済みとしてスキップ
        return fileAlreadyApplied(change);
      }
      return {
        change,
        failures: [],
        afterBytes: null,
        appliedBlocks: [],
        alreadyAppliedBlocks: [],
        alreadyApplied: false,
        totalBlocks: 0,
      };
    }
    case "replace": {
      if (!state.exists) {
        return fileFailure(change, "target-missing", "replace 指定ですがファイルが存在しません");
      }
      return planReplace(change, state, newFile.eol, options);
    }
  }
}

/** 新規ファイルの形式をパスごとに決める (newFile.encoding "auto" の推定結果を commands 層が渡す) */
export type NewFileResolver = (change: FileChange) => NewFileConfig;

/** 全ファイルをドライラン検証し適用計画を立てる (§4.1 手順 2)。書き込みは行わない */
export function planChangeSet(
  changeSet: ChangeSet,
  states: Map<string, FileState>,
  newFile: NewFileConfig | NewFileResolver,
  options: PlanOptions = {},
): Plan {
  const resolve: NewFileResolver = typeof newFile === "function" ? newFile : () => newFile;
  const planAll = (opts: PlanOptions): Plan => {
    const outcomes = changeSet.files.map((change) => {
      const state = states.get(change.path) ?? { exists: false, symlink: false, bytes: null };
      return planFile(change, state, resolve(change), opts);
    });
    const failures = outcomes.flatMap((o) => o.failures);
    return { outcomes, failures, ok: failures.length === 0 };
  };
  const plan = planAll(options);
  if (options.literalMasked === true && writesLiteralMask(plan) && losesMaskedValue(changeSet, states, plan)) {
    // [MASKED] の文字のまま書くと同時に、伏せた実際の値がどこかから消える (伏せ字の行の移動・ファイルの
    // 移動・書き換え)。実際の値を [MASKED] の文字で置き換えることになるため、指定を使わずに計画し直す
    const strict = planAll({ ...options, literalMasked: false });
    for (const f of strict.failures) {
      if (f.kind !== "masked-value") continue;
      f.literalRefused = true;
      delete f.literalAllowed;
    }
    return strict;
  }
  return plan;
}

/** [MASKED] の文字のまま書く行があるか (--literal-masked) */
function writesLiteralMask(plan: Plan): boolean {
  return plan.outcomes.some(
    (o) => (o.literalMasks ?? 0) > 0 || o.appliedBlocks.some((b) => (b.literalMasks ?? 0) > 0),
  );
}

/**
 * 変更する既存ファイルで伏せていた実際の値のどれかが、変更の後に数を減らすか。変更するファイル
 * (replace / rewrite / delete) と新しく作るファイルの全体で、変更の前後の伏せた値 (抜粋と同じ伏せ方。
 * 複数行にまたがる値は行ごと) を数えて比べる。伏せ方を対応づけられないファイルがあれば、減るものとして扱う
 */
function losesMaskedValue(changeSet: ChangeSet, states: Map<string, FileState>, plan: Plan): boolean {
  const linesOf = (bytes: Uint8Array): string[] | null => {
    try {
      return decodeFile(bytes).lines.map((l) => l.text);
    } catch {
      return null;
    }
  };
  // 元の値に戻すのは同じファイルの行からだけなので、値はファイルをまたいで移らない。ファイルごとに比べる
  // (別のファイルで同じ値の行を増やしても、消えた分を埋め合わせたことにしない)
  for (const o of plan.outcomes) {
    const path = o.change.path;
    const state = states.get(path);
    if (state === undefined || !state.exists || state.bytes === null) continue;
    const beforeLines = linesOf(state.bytes);
    // 読めないファイルは、伏せた値があるか確かめられないため減るものとして扱う
    if (beforeLines === null) return true;
    const before = maskedValueCounts(beforeLines, path);
    if (before === null) return true;
    if (before.size === 0) continue;
    let after = new Map<string, number>();
    if (!(o.change.op === "delete" && o.failures.length === 0)) {
      const bytes = o.afterBytes ?? state.bytes;
      const afterLines = linesOf(bytes);
      if (afterLines === null) return true;
      const counts = maskedValueCounts(afterLines, path);
      if (counts === null) return true;
      after = counts;
    }
    for (const [value, n] of before) {
      if ((after.get(value) ?? 0) < n) return true;
    }
  }
  return false;
}
