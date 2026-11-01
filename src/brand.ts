/**
 * ツールの名前と、名前に付いて回るファイル名・コマンド名。
 *
 * 名前は tazuna (手綱。2026-11-01 決定。設計書 §25.8-1)。旧名は petari (適用) と slnmix (パック)。
 * 改名するときは、ここと package.json の name / bin、README などの文書を変える。
 * 利用者のリポジトリに既に書かれている名前 (設計書の状態行 `<!-- slnmix design: ... -->`・slnmix.config.json・
 * .petari/) は、利用者のファイルを書き換えずに済むよう、ここの値とは別に扱う。
 */
import { join } from "node:path";

/** ツール名 (コマンド名・出力の見出しに使う) */
export const TOOL_NAME = "tazuna";

/** 適用の旧名 (petari 0.14.0 まで)。旧版が書いたもの (.petari/・規約文の 1 行目) を見分けるのに使う */
export const FORMER_TOOL_NAME = "petari";

/** パックを作るコマンド (利用者への案内に使う) */
export const PACK_COMMAND = `${TOOL_NAME} pack`;
/** ビルドしてエラーを渡すコマンド */
export const BUILD_COMMAND = `${TOOL_NAME} build`;
/** 初回セットアップのコマンド */
export const INIT_COMMAND = `${TOOL_NAME} init`;

/** PC ごとの設定 (config.json) と適用の履歴 (history/) を置くルート直下のディレクトリ */
export const STATE_DIRECTORY = `.${TOOL_NAME}`;
/** 旧版 (petari) が作ったディレクトリ。これだけがあるリポジトリでは引き続きこちらを使う */
export const LEGACY_STATE_DIRECTORY = `.${FORMER_TOOL_NAME}`;

/**
 * ルート直下で使う状態ディレクトリの名前。新しい名前のものが無く、旧名 (.petari/) だけがあれば旧名
 * (履歴・PC ごとの設定を引き継ぎ、利用者のファイルを動かさない)。どちらも無ければ新しい名前
 */
export function stateDirectoryName(rootDir: string, isDirectory: (absolutePath: string) => boolean): string {
  if (!isDirectory(join(rootDir, STATE_DIRECTORY)) && isDirectory(join(rootDir, LEGACY_STATE_DIRECTORY))) {
    return LEGACY_STATE_DIRECTORY;
  }
  return STATE_DIRECTORY;
}
