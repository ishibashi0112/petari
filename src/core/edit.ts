/**
 * ブラウザ編集の保存マージ (§4.3 + §8)。
 * textarea で送信された全文を FileDocument にマージする。変更していない行は
 * 元の DocLine (raw バイト・改行) をそのまま保持し、変更・追加行のみを
 * 再エンコード対象 (raw: null) にする — apply の replace と同じ §8 の方式。
 */
import { diffLines } from "./diff.ts";
import { findUnencodable, type DocLine, type FileDocument } from "./encoding.ts";

/**
 * textarea 送信テキストを行に分解する。フォーム送信の改行は CRLF に正規化されるため
 * \r\n / \r / \n を全て区切りとして扱う。末尾の空セグメント = 末尾改行あり
 * (decodeFile と同じ規約)。
 */
export function parseEditedText(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const segs = text.split(/\r\n|\r|\n/);
  if (segs[segs.length - 1] === "") return { lines: segs.slice(0, -1), trailingNewline: true };
  return { lines: segs, trailingNewline: false };
}

/** doc を textarea 表示用の全文にする (\n 結合。parseEditedText と往復可能) */
export function renderTextareaValue(doc: FileDocument): string {
  const joined = doc.lines.map((l) => l.text).join("\n");
  return doc.trailingNewline && doc.lines.length > 0 ? joined + "\n" : joined;
}

/**
 * 編集結果を doc にマージする。行 diff で整列し、テキストが一致する行は元の
 * DocLine をそのまま使う (raw バイト・実改行を保持)。
 * 既知の限界 (許容済み): 同一テキストで raw バイトだけ異なる重複行 (Shift_JIS の
 * NEC/IBM 拡張の重複マッピング等) は、他所の編集により diff の整列先が入れ替わり
 * raw が交換されることがある。デコード結果は同一のため実害はない。
 */
export function mergeEditedText(doc: FileDocument, editedText: string): FileDocument {
  const { lines: newTexts, trailingNewline } = parseEditedText(editedText);
  const ops = diffLines(
    doc.lines.map((l) => l.text),
    newTexts,
  );
  const lines: DocLine[] = [];
  for (const op of ops) {
    if (op.kind === "same") lines.push(doc.lines[op.a] as DocLine);
    else if (op.kind === "ins") lines.push({ text: newTexts[op.b] as string, raw: null, eol: null });
  }
  return {
    encoding: doc.encoding,
    hasBom: doc.hasBom,
    eol: doc.eol,
    trailingNewline,
    lines,
  };
}

/**
 * ブラウザ編集できない理由を返す (null = 編集可)。
 * HTML パーサは textarea 内の CR/CRLF を LF に正規化し NUL を U+FFFD に置換するため、
 * これらを含むファイルは「開いて保存しただけで壊れる」— 事前に編集を拒否する。
 * (閲覧のみの diff 表示には影響しない)
 */
export function browserEditBlockReason(doc: FileDocument): string | null {
  for (const line of doc.lines) {
    if (line.text.includes("\r") || line.text.includes("\u0000")) {
      return "CR のみの改行または NUL 文字を含むため、ブラウザでの編集はできません (HTML フォームが内容を変更してしまうため)";
    }
  }
  return null;
}

/** マージ後の再エンコード対象行 (raw: null) から変換不能文字を集める (§8 の事前検証) */
export function findMergeUnencodable(doc: FileDocument): string[] {
  if (doc.encoding === "utf8") return [];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const line of doc.lines) {
    if (line.raw !== null) continue;
    for (const ch of findUnencodable(line.text, doc.encoding)) {
      if (!seen.has(ch)) {
        seen.add(ch);
        bad.push(ch);
      }
    }
  }
  return bad;
}
