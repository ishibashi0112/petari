/**
 * Copilot Chat への受け渡し(v0.19.0、設計書 §21)。`npx slnmix` の後にクリップボードへ
 * 何を入れるかを決める(純粋関数。クリップボードの書き込みは clipboard.ts)。
 *
 * - パック全体が貼付上限の目安以内 → パック全体(先頭のリマインダと末尾の
 *   <task> / <procedure> / <instruction> を含む)を入れる。本文に 1 回貼るだけで
 *   添付は要らず、全文がコンテキストに入り、手順文・規約文も効く
 * - 超える → 本文用テキスト(.prompt.md と同じ内容)を入れる。パックは添付で渡す
 * - 本文用テキストも無い(--no-procedure かつ規約文・タスクなし)→ 入れない
 */

export type HandoffPlan =
  | { kind: "paste-pack"; text: string }
  | { kind: "paste-prompt"; text: string }
  | { kind: "none" };

/**
 * @param packContent パック全体(ファイルに書く内容。BOM なし)
 * @param promptText 本文用テキスト(無ければ undefined)
 * @param pasteLimit 貼付上限の目安(文字)
 */
export function planHandoff(
  packContent: string,
  promptText: string | undefined,
  pasteLimit: number,
): HandoffPlan {
  if (packContent.length <= pasteLimit) {
    return { kind: "paste-pack", text: packContent };
  }
  if (promptText !== undefined) {
    return { kind: "paste-prompt", text: promptText };
  }
  return { kind: "none" };
}
