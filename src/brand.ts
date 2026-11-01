/**
 * ツールの名前と、名前に付いて回るファイル名・コマンド名。
 *
 * 名前は検討中 (設計書 §25.8-1)。改名するときは、ここと package.json の name / bin、README などの文書を変える。
 * 利用者のリポジトリに既に書かれている名前 (設計書の状態行 `<!-- slnmix design: ... -->`・slnmix.config.json・
 * .petari/) は、利用者のファイルを書き換えずに済むよう、ここの値とは別に扱う。
 */

/** ツール名 (コマンド名・出力の見出しに使う) */
export const TOOL_NAME = "petari";

/** パックを作るコマンド (利用者への案内に使う) */
export const PACK_COMMAND = `${TOOL_NAME} pack`;
/** ビルドしてエラーを渡すコマンド */
export const BUILD_COMMAND = `${TOOL_NAME} build`;
/** 初回セットアップのコマンド */
export const INIT_COMMAND = `${TOOL_NAME} init`;
