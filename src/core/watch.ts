/**
 * petari watch の新着検出 (純粋ロジック。§4.7)。
 * 監視先の changes*.md の一覧 (パス・更新時刻・サイズ) を毎回受け取り、
 * 「監視開始後に現れた / 更新された、書き込みが落ち着いたファイル」を返す。
 *
 * - 開始時に既にあるファイルは対象外 (古い changes.md を黙って当てない)
 * - 書き込み途中を読まないよう、同じ時刻・サイズを 2 回続けて観測してから渡す
 * - 0 バイトは渡さない (Firefox は最終名の空ファイルを先に作り、完了時に置き換える)
 * - 一度渡したファイルは、内容が変わる (時刻かサイズが変わる) まで再び渡さない
 *   (失敗した changes.md を毎回当て直してレポートでクリップボードを上書きしないため)
 */

export interface WatchedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface WatchState {
  /** 処理済み (開始時に既にあった・渡し済み) のファイルとその時点の印 */
  settled: Map<string, string>;
  /** 前回の観測で新着・変化を見つけたファイルとその印 */
  pending: Map<string, string>;
}

const stamp = (f: WatchedFile): string => `${f.mtimeMs}:${f.size}`;

export function initialWatchState(files: readonly WatchedFile[]): WatchState {
  return { settled: new Map(files.map((f) => [f.path, stamp(f)])), pending: new Map() };
}

/**
 * 1 回分の観測を反映し、今回渡すファイルを古い順に返す。state は書き換える。
 * 一覧から消えたファイルは忘れる (同じ名前で再ダウンロードされたら新着として扱う)
 */
export function observeWatch<T extends WatchedFile>(state: WatchState, files: readonly T[]): T[] {
  const present = new Set(files.map((f) => f.path));
  for (const path of [...state.settled.keys()]) if (!present.has(path)) state.settled.delete(path);
  for (const path of [...state.pending.keys()]) if (!present.has(path)) state.pending.delete(path);

  const ready: T[] = [];
  for (const f of files) {
    const s = stamp(f);
    if (state.settled.get(f.path) === s) continue;
    if (f.size > 0 && state.pending.get(f.path) === s) {
      state.pending.delete(f.path);
      state.settled.set(f.path, s);
      ready.push(f);
      continue;
    }
    state.pending.set(f.path, s);
  }
  return ready.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}
