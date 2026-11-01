/**
 * designerSummary の単体テスト。
 * basic fixture の Designer.vb(VS2013 世代の生成コード相当)と、
 * インライン文字列(旧世代の行継続など)で検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DesignerControl,
  parseDesignerVb,
  renderDesignerControlLines,
} from "../../src/pack/services/designerSummary.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

function readFixtureDesigner(): string {
  return fs.readFileSync(
    path.join(FIXTURES_ROOT, "basic", "Forms", "OrderForm.Designer.vb"),
    "utf8",
  );
}

function findControl(
  controls: readonly DesignerControl[],
  name: string,
): DesignerControl | undefined {
  for (const control of controls) {
    if (control.name === name) {
      return control;
    }
    const nested = findControl(control.children, name);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

suite("designerSummary: fixture の Designer.vb", () => {
  const summary = parseDesignerVb(readFixtureDesigner());

  test("クラス名とフォームタイトルを抽出する", () => {
    assert.strictEqual(summary.className, "OrderForm");
    assert.strictEqual(summary.formText, "受注入力");
  });

  test("components(IContainer)を除きコントロールを全件抽出する", () => {
    assert.strictEqual(summary.controlCount, 9);
    assert.strictEqual(findControl(summary.rootControls, "components"), undefined);
  });

  test("Controls.Add による入れ子を親子関係にする", () => {
    const panel = findControl(summary.rootControls, "pnlHeader");
    assert.ok(panel !== undefined);
    assert.deepStrictEqual(
      panel.children.map((c) => c.name),
      ["lblCustomer", "txtCustomerName"],
    );
  });

  test("メニューの Items / DropDownItems も入れ子にする", () => {
    const menu = findControl(summary.rootControls, "mnuMain");
    assert.ok(menu !== undefined);
    assert.strictEqual(menu.children[0]?.name, "mnuFile");
    assert.strictEqual(menu.children[0]?.children[0]?.name, "mnuFileExit");
  });

  test("Text プロパティの文字列リテラルを拾う", () => {
    assert.strictEqual(findControl(summary.rootControls, "btnSave")?.text, "保存");
    assert.strictEqual(
      findControl(summary.rootControls, "mnuFile")?.text,
      "ファイル(&F)",
    );
  });

  test("System.Windows.Forms は短縮し、サードパーティ型は完全名のまま", () => {
    assert.strictEqual(findControl(summary.rootControls, "btnSave")?.typeName, "Button");
    assert.strictEqual(
      findControl(summary.rootControls, "grdItems")?.typeName,
      "FarPoint.Win.Spread.FpSpread",
    );
  });

  test("どこにも追加されないコンポーネント(Timer)もルートに残る", () => {
    assert.strictEqual(findControl(summary.rootControls, "tmrAutoSave")?.typeName, "Timer");
  });

  test("インデント付きの行にレンダリングできる", () => {
    const lines = renderDesignerControlLines(summary.rootControls);
    assert.ok(lines.includes('- btnSave: Button — Text "保存"'));
    assert.ok(lines.includes("  - txtCustomerName: TextBox"));
    assert.ok(!lines.some((l) => l.includes("Location")));
  });
});

suite("designerSummary: 旧世代・エッジケース", () => {
  test("行継続(_)付きの Controls.AddRange(VS2003 世代)を解析できる", () => {
    const source = [
      "Public Class OldForm",
      "    Friend WithEvents Panel1 As System.Windows.Forms.Panel",
      "    Friend WithEvents Button1 As System.Windows.Forms.Button",
      "    Friend WithEvents Button2 As System.Windows.Forms.Button",
      "    Private Sub InitializeComponent()",
      "        Me.Panel1.Controls.AddRange(New System.Windows.Forms.Control() {Me.Button1, _",
      "            Me.Button2})",
      "    End Sub",
      "End Class",
    ].join("\r\n");
    const summary = parseDesignerVb(source);
    const panel = findControl(summary.rootControls, "Panel1");
    assert.deepStrictEqual(
      panel?.children.map((c) => c.name),
      ["Button1", "Button2"],
    );
  });

  test("SplitContainer の内部パネルは先頭要素の下に寄せる", () => {
    const source = [
      "Partial Class SplitForm",
      "    Friend WithEvents SplitContainer1 As System.Windows.Forms.SplitContainer",
      "    Friend WithEvents TreeView1 As System.Windows.Forms.TreeView",
      "    Private Sub InitializeComponent()",
      "        Me.SplitContainer1.Panel1.Controls.Add(Me.TreeView1)",
      "    End Sub",
      "End Class",
    ].join("\n");
    const summary = parseDesignerVb(source);
    const split = findControl(summary.rootControls, "SplitContainer1");
    assert.strictEqual(split?.children[0]?.name, "TreeView1");
  });

  test('VB の "" エスケープを復元する', () => {
    const source = [
      "Partial Class QuoteForm",
      "    Friend WithEvents Label1 As System.Windows.Forms.Label",
      "    Private Sub InitializeComponent()",
      '        Me.Label1.Text = "値は ""未設定"" です"',
      "    End Sub",
      "End Class",
    ].join("\n");
    const summary = parseDesignerVb(source);
    assert.strictEqual(
      findControl(summary.rootControls, "Label1")?.text,
      '値は "未設定" です',
    );
  });

  test("コントロール宣言がなければ controlCount = 0", () => {
    const summary = parseDesignerVb(
      "Partial Class Empty\nEnd Class\n",
    );
    assert.strictEqual(summary.controlCount, 0);
    assert.deepStrictEqual(summary.rootControls, []);
  });

  test("壊れた入力でも例外を投げない", () => {
    const summary = parseDesignerVb("Me.Controls.Add(Me.X\n<<<>>>\n");
    assert.strictEqual(summary.controlCount, 0);
  });
});
