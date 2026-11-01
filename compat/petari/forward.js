/**
 * petari の引数の読み替え(純粋関数)。petari は 0.15.0 で tazuna に改名した(コマンドと引数は同じ)。
 * `-v` / `--version` は自分の版と呼び先の版を答える(tazuna と同じく `pack` の後ろのものは pack に渡す)。
 */

/** tazuna のサブコマンド(案内の文面に使う) */
const SUBCOMMANDS = ["pack", "build", "undo", "show", "list", "protocol", "init", "watch"];

/**
 * @param {readonly string[]} argv petari に渡された引数
 * @returns {{ kind: "version" } | { kind: "run"; args: string[]; notice: string }}
 */
export function planForward(argv) {
  const first = argv[0];
  if (first !== "pack" && (argv.includes("-v") || argv.includes("--version"))) {
    return { kind: "version" };
  }
  const command = first !== undefined && SUBCOMMANDS.includes(first) ? `tazuna ${first}` : "tazuna";
  return {
    kind: "run",
    args: [...argv],
    notice: `[petari] petari は tazuna に改名しました。同じ処理を npx ${command} で実行します(今後は npx ${command} を使ってください)。`,
  };
}
