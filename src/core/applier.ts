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
  isVbSource,
  maskedLines,
  restoreMaskedLines,
  type MaskRestoreResult,
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

/** 伏せ字を戻せなかったときの説明 (失敗レポートとして AI に貼られる前提の文面) */
function maskFailureMessage(prefix: string, r: MaskRestoreResult & { ok: false }): string {
  const what =
    r.reason === "ambiguous"
      ? "同じ数の伏せ字を含む行が複数あり、どの値か決まりません"
      : "元の値を持つ行が見つかりません";
  return (
    `${prefix}伏せ字 ${MASK_TOKEN} を元の値に戻せないため書き込めません (${what}: 「${r.line.trim()}」)。` +
    `${MASK_TOKEN} は実際の値を伏せた印です。伏せ字の行は SEARCH にそのまま含め、REPLACE でも ${MASK_TOKEN} を残してください。` +
    "伏せ字の行を新しく増やす変更や、伏せ字の数を変える変更はできません (その値は利用者が手で入れます)"
  );
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
  const vb = isVbSource(change.path);
  // 実ファイルにもともと [MASKED] という文字がある (伏せる処理そのものの実装など) なら
  // 伏せ字の照合と復元はしない (その文字を書き込む正当な変更と区別できないため)
  const literalMask = textLines.some(hasMaskToken);

  for (const block of change.blocks) {
    // 伏せた表示 (行の位置は実ファイルと同じ)。照合の補助と失敗レポートの抜粋に使う
    let view: string[] | null = null;
    const maskedView = (): string[] => (view ??= maskedLines(textLines, vb));
    let m = matchBlock(textLines, block);
    if (!m.ok && m.reason === "not-found" && !literalMask && block.search.some(hasMaskToken)) {
      // SEARCH の [MASKED] は伏せた表示となら一致する (slnmix のパックから写した行)
      const byMasked = matchBlock(maskedView(), block);
      if (byMasked.ok || byMasked.reason === "ambiguous") m = byMasked;
    }
    if (!m.ok) {
      // 冪等性 (§6): SEARCH 不一致でも REPLACE がまるごと存在すれば「適用済み」として
      // 成功扱いでスキップする (書き込みなし)。空・空行のみの REPLACE は判定対象外
      if (m.reason === "not-found") {
        const stage =
          findContentStage(textLines, block.replace) ??
          (!literalMask && block.replace.some(hasMaskToken)
            ? findContentStage(maskedView(), block.replace)
            : null);
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
      const nearest = analyzeNearest(maskedView(), block.search, applied.length > 0);
      // SEARCH が全滅のときのみ REPLACE 側で近傍を推定する (本来当てたかった箇所のヒント)。
      // fold 段のみの偶然一致をノイズとして弾くため matchCount >= 1 を要求する
      let nearestReplace: NearestAnalysis | undefined;
      if (nearest.window === null && checkedReplace) {
        const byReplace = analyzeNearest(maskedView(), block.replace, applied.length > 0, "REPLACE");
        if (byReplace.window !== null && byReplace.window.matchCount >= 1) {
          nearestReplace = byReplace;
        }
      }
      failures.push({
        path: change.path,
        kind: "block-not-found",
        message,
        block,
        nearest,
        ...(nearestReplace !== undefined ? { nearestReplace } : {}),
      });
      continue;
    }
    let replacement = m.replacement as string[];
    let restoredMasks = 0;
    if (!literalMask && replacement.some(hasMaskToken)) {
      // 伏せ字のまま書くと実際の値が消える。SEARCH の範囲の元の値に戻し、戻せなければ止める
      const r = restoreMaskedLines(replacement, maskedView(), textLines, {
        from: m.start,
        to: m.end,
        similar: true,
      });
      if (!r.ok) {
        failures.push({
          path: change.path,
          kind: "masked-value",
          message: maskFailureMessage(`ブロック ${block.index}: `, r),
          block,
        });
        continue;
      }
      replacement = r.lines;
      restoredMasks = r.restored;
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
    });
    const newDocLines: DocLine[] = replacement.map((text) => ({ text, raw: null, eol: null }));
    docLines = [...docLines.slice(0, m.start), ...newDocLines, ...docLines.slice(m.end)];
    textLines = [...textLines.slice(0, m.start), ...replacement, ...textLines.slice(m.end)];
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

function planFile(change: FileChange, state: FileState, newFile: NewFileConfig): FileOutcome {
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
      const maskedLine = change.content.find(hasMaskToken);
      if (maskedLine !== undefined) {
        return fileFailure(
          change,
          "masked-value",
          maskFailureMessage("新規ファイルには元の値がありません。", {
            ok: false,
            line: maskedLine,
            reason: "no-source",
          }),
        );
      }
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
      if (!current.some(hasMaskToken) && content.some(hasMaskToken)) {
        // 伏せ字は同じ文字列の行 (伏せた表示) から元の値に戻す。全文なので推定はしない
        const r = restoreMaskedLines(content, maskedLines(current, isVbSource(change.path)), current, {
          from: 0,
          to: current.length,
          similar: false,
        });
        if (!r.ok) return fileFailure(change, "masked-value", maskFailureMessage("", r));
        content = r.lines;
        restoredMasks = r.restored;
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
      return planReplace(change, state, newFile.eol);
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
): Plan {
  const resolve: NewFileResolver = typeof newFile === "function" ? newFile : () => newFile;
  const outcomes = changeSet.files.map((change) => {
    const state = states.get(change.path) ?? { exists: false, symlink: false, bytes: null };
    return planFile(change, state, resolve(change));
  });
  const failures = outcomes.flatMap((o) => o.failures);
  return { outcomes, failures, ok: failures.length === 0 };
}
