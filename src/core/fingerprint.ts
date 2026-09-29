/**
 * changes.md の指紋 (§5, §6.1)。同じ changes.md の再適用 (取り違え・二重実行) を
 * 履歴と突き合わせて止めるために使う。
 *
 * パース後の変更内容 (パス・操作・ブロック/本文の行) だけから算出する。
 * チャットの前置き・CHANGES 概要・改行コード・寛容パースで補正したマーカー表記の
 * 違いは指紋に影響しない (同じ変更なら同じ指紋)。
 */
import { createHash } from "node:crypto";
import type { ChangeSet } from "../types.ts";

export function changeSetFingerprint(changeSet: ChangeSet): string {
  const normalized = changeSet.files.map((f) => {
    switch (f.op) {
      case "replace":
        return { path: f.path, op: f.op, blocks: f.blocks.map((b) => [b.search, b.replace]) };
      case "create":
      case "rewrite":
        return { path: f.path, op: f.op, content: f.content };
      case "delete":
        return { path: f.path, op: f.op };
    }
  });
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}
