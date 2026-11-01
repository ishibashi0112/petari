/** forward.js の型(テスト用。パッケージには入れない) */
export function planForward(
  argv: readonly string[],
): { kind: "version" } | { kind: "run"; args: string[]; notice: string };
