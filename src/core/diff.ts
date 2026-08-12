/**
 * 行単位の diff (§4.3 ブラウザ差分ビュー用)。
 *
 * 不変条件: どんな入力でも「ops を a に適用すると b が完全再現される」。
 * Myers の探索を maxD で打ち切った場合は中間部を全削除+全挿入として返すため、
 * diff の品質はマージ (core/edit.ts) の正しさに影響しない — 打ち切りは
 * raw バイトを保持できる行が減るだけ。
 */

export type DiffOp =
  | { kind: "same"; a: number; b: number }
  | { kind: "del"; a: number }
  | { kind: "ins"; b: number };

const DEFAULT_MAX_D = 2000;

/** 行配列 a → b の差分を返す。インデックスはともに 0-based */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  maxD: number = DEFAULT_MAX_D,
): DiffOp[] {
  // 共通の前置き・後置きを先に確定する (パッチ適用前後の比較では大半が共通)
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: "same", a: i, b: i });
  for (const op of diffMiddle(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxD)) {
    if (op.kind === "same") ops.push({ kind: "same", a: op.a + pre, b: op.b + pre });
    else if (op.kind === "del") ops.push({ kind: "del", a: op.a + pre });
    else ops.push({ kind: "ins", b: op.b + pre });
  }
  for (let i = 0; i < suf; i++) {
    ops.push({ kind: "same", a: a.length - suf + i, b: b.length - suf + i });
  }
  return ops;
}

/** 全削除 + 全挿入 (共通行の探索なし)。maxD 打ち切り時のフォールバック */
function fallbackAll(n: number, m: number): DiffOp[] {
  const ops: DiffOp[] = [];
  for (let i = 0; i < n; i++) ops.push({ kind: "del", a: i });
  for (let j = 0; j < m; j++) ops.push({ kind: "ins", b: j });
  return ops;
}

/** Myers O(ND) 貪欲法。a と b は共通の前置き・後置きを持たない前提 */
function diffMiddle(a: readonly string[], b: readonly string[], maxD: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return fallbackAll(n, m);

  // |k| <= d <= cap なので V 配列は 2*cap+1 で足りる (スナップショット総量の上限も抑える)
  const cap = Math.min(n + m, maxD);
  const offset = cap;
  const v = new Int32Array(2 * cap + 1);
  const trace: Int32Array[] = [];
  let found = -1;

  outer: for (let d = 0; d <= cap; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found === -1) return fallbackAll(n, m);

  // バックトラック (trace[d] は深さ d-1 終了時点の V)
  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vp = trace[d] as Int32Array;
    const k = x - y;
    const down =
      k === -d || (k !== d && (vp[offset + k - 1] as number) < (vp[offset + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vp[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rev.push({ kind: "same", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    rev.push(down ? { kind: "ins", b: prevY } : { kind: "del", a: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    rev.push({ kind: "same", a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return rev.reverse();
}

/** 文字単位の変更範囲 (コードポイント index、[start, end)) */
export interface CharRange {
  start: number;
  end: number;
}

/**
 * change ペア行の文字単位ハイライト範囲を両側分返す (表示専用)。
 * 長い行や乖離が大きい行は行全体の範囲にフォールバックする (品質のみ低下)。
 */
export function intralineRanges(a: string, b: string): { left: CharRange[]; right: CharRange[] } {
  const A = Array.from(a);
  const B = Array.from(b);
  if (A.length > 1000 || B.length > 1000) {
    return {
      left: A.length > 0 ? [{ start: 0, end: A.length }] : [],
      right: B.length > 0 ? [{ start: 0, end: B.length }] : [],
    };
  }
  const push = (arr: CharRange[], i: number): void => {
    const last = arr[arr.length - 1];
    if (last !== undefined && last.end === i) last.end = i + 1;
    else arr.push({ start: i, end: i + 1 });
  };
  const left: CharRange[] = [];
  const right: CharRange[] = [];
  for (const op of diffLines(A, B, 500)) {
    if (op.kind === "del") push(left, op.a);
    else if (op.kind === "ins") push(right, op.b);
  }
  return { left, right };
}

/** side-by-side 表示の 1 行。no は 1-based 行番号 */
export interface DiffRow {
  kind: "same" | "del" | "ins" | "change";
  left: { no: number; text: string } | null;
  right: { no: number; text: string } | null;
}

/** ops を side-by-side 表示用の行に変換する (連続する del/ins は左右にペアで並べる) */
export function toSideBySideRows(
  a: readonly string[],
  b: readonly string[],
  ops: readonly DiffOp[],
): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i] as DiffOp;
    if (op.kind === "same") {
      rows.push({
        kind: "same",
        left: { no: op.a + 1, text: a[op.a] as string },
        right: { no: op.b + 1, text: b[op.b] as string },
      });
      i++;
      continue;
    }
    const dels: number[] = [];
    const inss: number[] = [];
    while (i < ops.length && (ops[i] as DiffOp).kind !== "same") {
      const o = ops[i] as DiffOp;
      if (o.kind === "del") dels.push(o.a);
      else if (o.kind === "ins") inss.push(o.b);
      i++;
    }
    const len = Math.max(dels.length, inss.length);
    for (let r = 0; r < len; r++) {
      const ai = dels[r];
      const bi = inss[r];
      rows.push({
        kind: ai !== undefined && bi !== undefined ? "change" : ai !== undefined ? "del" : "ins",
        left: ai !== undefined ? { no: ai + 1, text: a[ai] as string } : null,
        right: bi !== undefined ? { no: bi + 1, text: b[bi] as string } : null,
      });
    }
  }
  return rows;
}
