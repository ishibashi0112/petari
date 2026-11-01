/**
 * .vbproj を読むための小さな XML の読み取り。
 *
 * 実行時依存ゼロのため fast-xml-parser の代わりに自前で持つ(設計書 §25.3-3)。vbprojParser が受け取る形は
 * fast-xml-parser に次の設定を渡したときと同じにする(vbprojParser を変えないため):
 * ignoreAttributes: false / attributeNamePrefix: "@_" / removeNSPrefix: true / parseTagValue: false /
 * parseAttributeValue: false / trimValues: true
 *
 * - 子要素も属性もない要素は文字列(テキスト。空なら "")
 * - それ以外はオブジェクト。キーの並びは子要素(最初に出た順)→ `#text` → 属性(`@_` 接頭辞)
 * - 同じ名前の子要素が 2 つ以上あれば配列
 * - 名前空間の接頭辞は外し、`xmlns` / `xmlns:*` 属性は落とす
 * - テキストはタグ・CDATA で区切った部分ごとに前後の空白を落としてつなぐ(コメントでは区切らない。CDATA はそのまま)。
 *   空白だけのテキストは捨てる
 * - 実体参照は `&lt;` `&gt;` `&quot;` `&apos;` `&amp;` だけを戻す(fast-xml-parser の既定と同じく数値文字参照は戻さない)
 * - 改行は LF にそろえる。コメント・処理命令・DOCTYPE は読み飛ばす(DOCTYPE で宣言した実体は戻さない)
 *
 * 壊れた XML(閉じていないタグ・対応しない閉じタグ・引用符のない属性値・重複した属性・ルート要素の前の文字・
 * テキストの中の実体参照になっていない &)は
 * 行番号つきのエラーにする。ルート要素が複数あっても読む(fast-xml-parser と同じ)。
 */

export type XmlValue = string | XmlElement | XmlValue[];
export interface XmlElement {
  [key: string]: XmlValue;
}

export type XmlParseResult =
  | { ok: true; document: XmlElement }
  | { ok: false; message: string; line: number };

interface Frame {
  rawName: string;
  name: string;
  /** 開始タグの位置(エラーの行番号用) */
  start: number;
  children: Map<string, XmlValue>;
  text: string;
  /** まだ text に足していない生のテキスト(コメントをはさんで続く分も 1 つにまとめてから前後の空白を落とす) */
  pending: string;
  attributes: [string, string][];
}

class XmlError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 実体参照の形になっていない & の位置(なければ -1) */
function bareAmpersand(value: string): number {
  const re = /&(?![A-Za-z_][\w.-]*;|#[0-9]+;|#x[0-9A-Fa-f]+;)/g;
  const m = re.exec(value);
  return m === null ? -1 : m.index;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function addChild(children: Map<string, XmlValue>, name: string, value: XmlValue): void {
  const existing = children.get(name);
  if (existing === undefined) {
    children.set(name, value);
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    children.set(name, [existing, value]);
  }
}

function elementValue(frame: Frame): XmlValue {
  if (frame.children.size === 0 && frame.attributes.length === 0) {
    return frame.text;
  }
  const element: XmlElement = {};
  for (const [name, value] of frame.children) {
    element[name] = value;
  }
  if (frame.text !== "") {
    element["#text"] = frame.text;
  }
  for (const [name, value] of frame.attributes) {
    element[`@_${name}`] = value;
  }
  return element;
}

const NAME = /[^\s<>/=!?"'&]+/y;
const SPACE = /\s*/y;

function readName(xml: string, pos: number): string | undefined {
  NAME.lastIndex = pos;
  const m = NAME.exec(xml);
  return m === null ? undefined : m[0];
}

function skipSpace(xml: string, pos: number): number {
  SPACE.lastIndex = pos;
  SPACE.exec(xml);
  return SPACE.lastIndex;
}

function lineAt(xml: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < xml.length; i++) {
    if (xml.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** XML を読む。壊れていればエラーの文面と行番号を返す */
export function parseXml(source: string): XmlParseResult {
  const xml = source.replace(/\r\n?/g, "\n");
  try {
    return { ok: true, document: parse(xml) };
  } catch (error) {
    if (error instanceof XmlError) {
      return { ok: false, message: error.message, line: lineAt(xml, error.position) };
    }
    throw error;
  }
}

function parse(xml: string): XmlElement {
  const root: Frame = { rawName: "", name: "", start: 0, children: new Map(), text: "", pending: "", attributes: [] };
  const stack: Frame[] = [root];
  let pos = 0;
  const top = (): Frame => stack[stack.length - 1] ?? root;
  /** たまったテキストを足す(タグ・CDATA の前で区切る。コメントでは区切らない) */
  const flush = (): void => {
    const frame = top();
    frame.text += decodeEntities(frame.pending.trim());
    frame.pending = "";
  };

  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > pos) {
      const text = xml.slice(pos, textEnd);
      if (stack.length === 1) {
        // ルート要素の前の文字はエラー、後ろの文字は読み飛ばす(fast-xml-parser と同じ)
        const offset = root.children.size === 0 ? text.search(/\S/) : -1;
        if (offset >= 0) {
          throw new XmlError(`ルート要素の外に文字 '${text.charAt(offset)}' があります`, pos + offset);
        }
      } else {
        const amp = bareAmpersand(text);
        if (amp >= 0) throw new XmlError("& が実体参照になっていません(&amp; と書きます)", pos + amp);
        top().pending += text;
      }
    }
    if (lt < 0) break;
    pos = lt;

    if (xml.startsWith("<!--", pos)) {
      const end = xml.indexOf("-->", pos + 4);
      if (end < 0) throw new XmlError("コメントが閉じていません", pos);
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", pos)) {
      const end = xml.indexOf("]]>", pos + 9);
      if (end < 0) throw new XmlError("CDATA が閉じていません", pos);
      if (stack.length === 1) throw new XmlError("ルート要素の外に CDATA があります", pos);
      flush();
      top().text += xml.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    flush();
    if (xml.startsWith("<?", pos)) {
      const end = xml.indexOf("?>", pos + 2);
      if (end < 0) throw new XmlError("処理命令が閉じていません", pos);
      pos = end + 2;
      continue;
    }
    if (xml.startsWith("<!", pos)) {
      // DOCTYPE(内部サブセット [...] を含む)
      let i = pos + 2;
      let depth = 0;
      for (; i < xml.length; i++) {
        const ch = xml[i];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        else if (ch === ">" && depth <= 0) break;
      }
      if (i >= xml.length) throw new XmlError("宣言が閉じていません", pos);
      pos = i + 1;
      continue;
    }
    if (xml.startsWith("</", pos)) {
      const name = readName(xml, pos + 2);
      if (name === undefined) throw new XmlError("閉じタグの名前がありません", pos);
      const after = skipSpace(xml, pos + 2 + name.length);
      if (xml[after] !== ">") throw new XmlError(`閉じタグ </${name}> が閉じていません`, pos);
      const frame = top();
      if (stack.length === 1) throw new XmlError(`対応する開始タグのない閉じタグ </${name}> があります`, pos);
      if (frame.rawName !== name) {
        throw new XmlError(
          `閉じタグ </${name}> が開始タグ <${frame.rawName}>(${lineAt(xml, frame.start)} 行目)と対応しません`,
          pos,
        );
      }
      stack.pop();
      addChild(top().children, frame.name, elementValue(frame));
      pos = after + 1;
      continue;
    }

    // 開始タグ
    const rawName = readName(xml, pos + 1);
    if (rawName === undefined) throw new XmlError("タグの名前がありません", pos);
    const frame: Frame = {
      rawName,
      name: localName(rawName),
      start: pos,
      children: new Map(),
      text: "",
      pending: "",
      attributes: [],
    };
    const seen = new Set<string>();
    let i = pos + 1 + rawName.length;
    let selfClosing = false;
    for (;;) {
      const spaced = skipSpace(xml, i);
      const ch = xml[spaced];
      if (ch === undefined) throw new XmlError(`タグ <${rawName}> が閉じていません`, pos);
      if (ch === ">") {
        i = spaced + 1;
        break;
      }
      if (ch === "/" && xml[spaced + 1] === ">") {
        selfClosing = true;
        i = spaced + 2;
        break;
      }
      if (spaced === i) throw new XmlError(`タグ <${rawName}> の属性の前に空白がありません`, spaced);
      const attrName = readName(xml, spaced);
      if (attrName === undefined) throw new XmlError(`タグ <${rawName}> に読めない文字 '${ch}' があります`, spaced);
      const eq = skipSpace(xml, spaced + attrName.length);
      if (xml[eq] !== "=") throw new XmlError(`属性 ${attrName} に値がありません`, spaced);
      const quotePos = skipSpace(xml, eq + 1);
      const quote = xml[quotePos];
      if (quote !== '"' && quote !== "'") throw new XmlError(`属性 ${attrName} の値が引用符で囲まれていません`, spaced);
      const close = xml.indexOf(quote, quotePos + 1);
      if (close < 0) throw new XmlError(`属性 ${attrName} の値が閉じていません`, spaced);
      const raw = xml.slice(quotePos + 1, close);
      if (seen.has(attrName)) throw new XmlError(`属性 ${attrName} が重複しています`, spaced);
      seen.add(attrName);
      if (attrName !== "xmlns" && !attrName.startsWith("xmlns:")) {
        frame.attributes.push([localName(attrName), decodeEntities(raw.trim())]);
      }
      i = close + 1;
    }
    pos = i;
    if (selfClosing) {
      addChild(top().children, frame.name, elementValue(frame));
    } else {
      stack.push(frame);
    }
  }

  if (stack.length > 1) {
    const open = top();
    throw new XmlError(`タグ <${open.rawName}> が閉じていません`, open.start);
  }
  const document: XmlElement = {};
  for (const [name, value] of root.children) {
    document[name] = value;
  }
  return document;
}
