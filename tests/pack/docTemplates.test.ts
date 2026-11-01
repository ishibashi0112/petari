/**
 * 文書ひな型(assets/docTemplates)の章立てのテスト。
 * 手順文 v6 の「自動テスト」の節は、仕様書・設計書の章番号を名指しで参照する
 * (仕様書 §3-2 / §3-3 / §4 / §5 / §7 / §8、設計書 §3-3 / §4-2 / §4-3 / §5 / §5-3 / §8 / §9)。
 * 章立てを変えるときは手順文の表(TEST_SECTIONS)も追従させること。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import { DOC_TEMPLATES, DOC_TEMPLATES_VERSION } from "../../src/pack/assets/docTemplates.ts";
import { TEST_SECTIONS } from "../../src/pack/assets/procedure.ts";

function headings(text: string, level: "##" | "###"): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${level} `))
    .map((line) => line.slice(level.length + 1));
}

suite("docTemplates: 章立て", () => {
  test("ひな型の版は 4(テスト節の追加)", () => {
    assert.strictEqual(DOC_TEMPLATES_VERSION, 4);
  });

  test("仕様書: 「10. テスト」を追加し、未実装・更新履歴を 11 / 12 に繰り下げる", () => {
    assert.deepStrictEqual(headings(DOC_TEMPLATES.spec, "##"), [
      "1. 概要",
      "2. 用語",
      "3. 画面と操作",
      "4. 機能一覧",
      "5. 処理フロー(機能ごと)",
      "6. データ",
      "7. 業務ルール・制約",
      "8. エラー時・0 件時の振る舞い",
      "9. 設計からの意図的な逸脱",
      "10. テスト",
      "11. 未実装・既知の制限",
      "12. 更新履歴",
    ]);
    assert.deepStrictEqual(headings(DOC_TEMPLATES.spec, "###").slice(0, 3), [
      "3-1. 画面構成",
      "3-2. 操作一覧",
      "3-3. 入力項目",
    ]);
    const testChapter = DOC_TEMPLATES.spec.slice(
      DOC_TEMPLATES.spec.indexOf("## 10. テスト"),
      DOC_TEMPLATES.spec.indexOf("## 11. "),
    );
    assert.ok(testChapter.includes("| 機能 | 層 | テストファイル | 手動確認が要る項目 |"));
    assert.ok(testChapter.includes("e2e/<層>/<名前>.spec.ts"));
    assert.ok(testChapter.includes("「該当なし」"));
  });

  test("設計書: §9 の完了条件を自動テストと手動確認に分ける。手順文が参照する章はそのまま", () => {
    const design = DOC_TEMPLATES.design;
    assert.ok(
      design.includes(
        "| バッチ | 内容 | 完了条件: 自動テスト(ファイル名) | 完了条件: 手動確認(項目) | 着手前に回答が要る確認事項 | 状態 |",
      ),
    );
    assert.ok(design.includes("## 9. 実装バッチ計画"));
    assert.ok(design.includes("## 10. 確認事項"));
    assert.ok(design.includes("## 12. 更新履歴"));
    for (const heading of [
      "### 3-3. キー・採番・突き合わせの規則",
      "### 4-2. 入力項目と検証",
      "### 4-3. 操作(ボタン・メニュー)と活性条件",
      "## 5. 処理仕様",
      "### 5-3. トランザクション・排他・監査列",
      "## 8. エラー処理・0 件時の方針",
    ]) {
      assert.ok(design.includes(`\n${heading}\n`), `設計書に ${heading} がない`);
    }
  });

  test("引継ぎ書: §7 動作確認の記録を自動テストと手動確認に分ける", () => {
    const handoff = DOC_TEMPLATES.handoff;
    assert.ok(handoff.includes("## 7. 動作確認の記録\n\n- 自動テスト: "));
    assert.ok(handoff.includes("\n- 手動確認: "));
    assert.ok(handoff.includes("失敗 0 件"));
  });

  test("手順文の観点表が参照する章番号が、ひな型の章立てと一致する", () => {
    const table = TEST_SECTIONS.split("\n").filter((line) => line.startsWith("| "));
    const refs = table.flatMap((line) => [...line.matchAll(/(仕様書|設計書) §([\d-]+) ([^/|]+?)(?: \/|\s*\|)/g)]);
    // 6 行 × 2 参照 − 最終行(設計書のみ)= 11
    assert.strictEqual(refs.length, 11, `観点表の参照が読み取れない: ${refs.length}`);
    for (const ref of refs) {
      const [, doc, number, title] = ref;
      const source = doc === "仕様書" ? DOC_TEMPLATES.spec : DOC_TEMPLATES.design;
      const marker = number!.includes("-") ? `### ${number}. ` : `## ${number}. `;
      const line = source.split(/\r?\n/).find((l) => l.startsWith(marker));
      assert.ok(line !== undefined, `${doc} §${number} がひな型にない`);
      // 表では短縮した見出し(例: 「エラー時・0 件時」、「操作と活性条件」)を使うので、
      // ひな型側の括弧書きを除いたうえで先頭一致で照合
      const stripped = line.replace(/[(（][^)）]*[)）]/g, ""); // 括弧書き(半角・全角とも)を除く
      const head = title!.trim().split(/[・(]/)[0]!;
      assert.ok(
        stripped.includes(head) || stripped.includes(title!.trim()),
        `${doc} §${number} の見出し「${line}」が表の「${title}」と合わない`,
      );
    }
  });
});
