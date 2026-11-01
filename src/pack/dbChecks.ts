/**
 * AI チャットだけでの DB 確認・動作検証(手順文 v8 / v9、2026-10-13)。
 *
 * ルート直下の docs/db/schema.md(ashiato schema の出力。テスト用 DB の
 * テーブル定義で、行の値は含まない)があるときだけ、パックに <db_schema> として
 * 入れ、手順文に「DB の確認」「動作検証」の節を足す(procedure.ts の DB_SECTIONS)。
 * AI は確認用の SELECT を checks/*.sql で、操作と期待する DB の変化を
 * checks/*.verify.md で出し、ユーザーが ashiato query / ashiato verify で
 * 実行して結果をチャットに貼る。slnmix 自身は DB に接続しない。
 *
 * 本文用テキストには入れない(テーブルが多いと貼付の上限を超えるため。
 * 添付の中のデータは検索で参照される)。ファイルシステムは deps 注入。
 */

import * as path from "node:path";
import { DB_SCHEMA_PATH } from "./assets/procedure.ts";

export interface DbSchemaEntry {
  /** ルート相対・`/` 区切り */
  relativePath: string;
  content: string;
}

export interface DbChecksDeps {
  readTextFile(absolutePath: string): string | undefined;
}

/** ルートの docs/db/schema.md を読む。なければ undefined(DB の確認は無効) */
export function resolveDbSchema(rootDir: string, deps: DbChecksDeps): DbSchemaEntry | undefined {
  const content = deps.readTextFile(path.resolve(rootDir, ...DB_SCHEMA_PATH.split("/")));
  return content === undefined ? undefined : { relativePath: DB_SCHEMA_PATH, content };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * <db_schema> ブロック(閉じタグ・末尾改行込み)。
 * @param transform 認証情報マスク等(文書と同じ変換を通す)
 */
export function renderDbSchemaBlock(
  schema: DbSchemaEntry,
  transform: (text: string) => string = (t) => t,
): string {
  const body = transform(schema.content).replace(/\r?\n$/, "");
  return `<db_schema path="${escapeAttribute(schema.relativePath)}">\nテスト用 DB のテーブル定義(ashiato schema の出力。行の値は含まない)。確認用の SQL はこの定義に合わせて書く。\n\n${body}\n</db_schema>\n`;
}

/** CLI の 1 行表示用 */
export function describeDbSchema(schema: DbSchemaEntry | undefined): string {
  return schema === undefined
    ? `なし(${DB_SCHEMA_PATH} がありません)`
    : `あり(${schema.relativePath}、${schema.content.length.toLocaleString("en-US")} 文字)`;
}
