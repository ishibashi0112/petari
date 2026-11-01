/**
 * WinForms Designer.vb の要約(UI サマリー)。
 *
 * デザイナー自動生成コード(InitializeComponent)を軽量解析し、
 * 「どんなコントロールが何という名前で存在し、表示テキストは何か、
 * どのコンテナの中にあるか」だけを抽出する。座標・サイズ・フォント等の
 * レイアウト詳細は捨てる。AI へ渡す出力のトークン量を抑えつつ、
 * 本体コード(Me.btnSave 等)の理解に必要な情報を残すのが目的。
 *
 * VB の完全な構文解析は行わない(行単位の正規表現マッチ)。
 * 解析できない行は無視する。要約である以上、取りこぼしは許容し、
 * 原文が必要な場合は Designer 原文を含めるオプション側で対応する。
 */

/** 抽出したコントロール 1 件(children は Controls.Add 等による入れ子) */
export interface DesignerControl {
  name: string;
  /** 表示用の型名(System.Windows.Forms. 前置は短縮済み) */
  typeName: string;
  /** Text プロパティの文字列リテラル(リテラル以外は取得しない) */
  text?: string | undefined;
  children: DesignerControl[];
}

export interface DesignerSummary {
  /** Partial Class 名(見つからなければ undefined) */
  className?: string | undefined;
  /** フォーム自身の Text(タイトルバー文字列) */
  formText?: string | undefined;
  /** フォーム直下(または親を特定できなかった)コントロール。宣言順 */
  rootControls: DesignerControl[];
  /** 宣言から抽出したコントロール総数 */
  controlCount: number;
}

/** メンバー宣言: Friend WithEvents btnSave As System.Windows.Forms.Button */
const DECLARATION =
  /^\s*(?:Friend|Public|Private|Protected)(?:\s+Friend)?\s+(?:Shadows\s+)?(?:WithEvents\s+)?([A-Za-z_]\w*)\s+As\s+([A-Za-z_][\w.]*)\s*(?:'.*)?$/;

/** コントロールの Text 代入: Me.btnSave.Text = "保存" */
const CONTROL_TEXT =
  /^\s*Me\.([A-Za-z_]\w*)\.Text\s*=\s*"((?:[^"]|"")*)"/;

/** フォーム自身の Text 代入: Me.Text = "受注入力" */
const FORM_TEXT = /^\s*Me\.Text\s*=\s*"((?:[^"]|"")*)"/;

/** 入れ子: Me.pnlHeader.Controls.Add(Me.lblCustomer) / Me.Controls.Add(...) */
const CONTROLS_ADD =
  /\bMe(?:\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))?\.Controls\.Add\(Me\.([A-Za-z_]\w*)\)/;

/**
 * 一括追加: Me.mnuMain.Items.AddRange(New ... {Me.mnuFile, Me.mnuEdit})
 * Controls(VS2003 世代) / Items / DropDownItems(メニュー・ツールバー)を対象
 */
const ADD_RANGE =
  /\bMe(?:\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))?\.(?:Controls|Items|DropDownItems)\.AddRange\([^{]*\{([^}]*)\}/;

/** Partial Class OrderForm(属性行・コメント行は対象外) */
const CLASS_NAME = /\bClass\s+([A-Za-z_]\w*)/;

/** 宣言から除外する型(コンポーネント管理用のインフラ) */
function isInfrastructureType(typeName: string): boolean {
  return typeName.startsWith("System.ComponentModel.");
}

function shortenTypeName(typeName: string): string {
  const prefix = "System.Windows.Forms.";
  return typeName.startsWith(prefix) ? typeName.slice(prefix.length) : typeName;
}

function unescapeVbString(literal: string): string {
  return literal.replace(/""/g, '"');
}

/**
 * Designer.vb のソースを要約する。
 * コントロール宣言が 1 件も見つからなければ controlCount = 0 を返す
 * (呼び出し側はその場合サマリーを出力しない)。
 */
export function parseDesignerVb(source: string): DesignerSummary {
  // VB の行継続(` _`)を結合してから行単位で処理する(VS2003 世代の
  // 複数行 AddRange 対策)
  const joined = source.replace(/[ \t]_\r?\n[ \t]*/g, " ");
  const lines = joined.split(/\r?\n/);

  let className: string | undefined;
  let formText: string | undefined;
  const declared = new Map<string, { typeName: string; text?: string }>();
  /** 子コントロール名 → 親コントロール名(undefined = フォーム直下と判明) */
  const parentOf = new Map<string, string | undefined>();

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("'")) {
      continue;
    }
    if (className === undefined && !trimmed.startsWith("<")) {
      const classMatch = CLASS_NAME.exec(line);
      if (classMatch !== null) {
        className = classMatch[1] ?? "";
      }
    }
    const declaration = DECLARATION.exec(line);
    if (declaration !== null) {
      const name = declaration[1] ?? "";
      const typeName = declaration[2] ?? "";
      if (name !== "components" && !isInfrastructureType(typeName)) {
        declared.set(name, { typeName: shortenTypeName(typeName) });
      }
      continue;
    }
    const controlText = CONTROL_TEXT.exec(line);
    if (controlText !== null) {
      const entry = declared.get(controlText[1] ?? "");
      if (entry !== undefined && entry.text === undefined) {
        entry.text = unescapeVbString(controlText[2] ?? "");
      }
      continue;
    }
    const formTextMatch = FORM_TEXT.exec(line);
    if (formTextMatch !== null && formText === undefined) {
      formText = unescapeVbString(formTextMatch[1] ?? "");
      continue;
    }
    const add = CONTROLS_ADD.exec(line);
    if (add !== null) {
      recordParent(parentOf, declared, add[1] ?? "", [add[2] ?? ""]);
      continue;
    }
    const addRange = ADD_RANGE.exec(line);
    if (addRange !== null) {
      const children = [...(addRange[2] ?? "").matchAll(/Me\.([A-Za-z_]\w*)/g)].map(
        (m) => m[1] ?? "",
      );
      recordParent(parentOf, declared, addRange[1] ?? "", children);
    }
  }

  // 宣言順にノードを作り、親が特定できたものだけ入れ子にする
  const nodes = new Map<string, DesignerControl>();
  for (const [name, entry] of declared) {
    const node: DesignerControl = { name, typeName: entry.typeName, children: [] };
    if (entry.text !== undefined) {
      node.text = entry.text;
    }
    nodes.set(name, node);
  }
  const rootControls: DesignerControl[] = [];
  for (const [name, node] of nodes) {
    const parentName = parentOf.get(name);
    const parent = parentName === undefined ? undefined : nodes.get(parentName);
    if (parent !== undefined && parent !== node) {
      parent.children.push(node);
    } else {
      rootControls.push(node);
    }
  }

  const summary: DesignerSummary = {
    rootControls,
    controlCount: declared.size,
  };
  if (className !== undefined) {
    summary.className = className;
  }
  if (formText !== undefined) {
    summary.formText = formText;
  }
  return summary;
}

/**
 * 親チェーン(例: "pnlHeader" / "SplitContainer1.Panel1" / undefined=フォーム直下)
 * を宣言済みコントロール名へ解決して記録する。既に親が付いた子は上書きしない
 */
function recordParent(
  parentOf: Map<string, string | undefined>,
  declared: Map<string, { typeName: string }>,
  parentChain: string | undefined,
  children: string[],
): void {
  let parentName: string | undefined;
  if (parentChain !== undefined) {
    if (declared.has(parentChain)) {
      parentName = parentChain;
    } else {
      // SplitContainer1.Panel1 のような内部パネルは先頭要素へ寄せる
      const firstSegment = parentChain.split(".")[0] ?? "";
      parentName = declared.has(firstSegment) ? firstSegment : undefined;
    }
  }
  for (const child of children) {
    if (!parentOf.has(child) && child !== parentName) {
      parentOf.set(child, parentName);
    }
  }
}

/** サマリーを「- name: Type — Text "..."」のインデント付き行にする */
export function renderDesignerControlLines(
  controls: readonly DesignerControl[],
  depth = 0,
  lines: string[] = [],
): string[] {
  for (const control of controls) {
    const textPart = control.text === undefined ? "" : ` — Text "${control.text}"`;
    lines.push(`${"  ".repeat(depth)}- ${control.name}: ${control.typeName}${textPart}`);
    renderDesignerControlLines(control.children, depth + 1, lines);
  }
  return lines;
}
