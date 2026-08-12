import { describe, expect, it } from "vitest";
import {
  browserEditBlockReason,
  findMergeUnencodable,
  mergeEditedText,
  parseEditedText,
  renderTextareaValue,
} from "../src/core/edit.ts";
import { decodeFile, encodeDocument } from "../src/core/encoding.ts";
import { sjisEncode } from "../src/core/sjis.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sjis = (s: string): Uint8Array => {
  const r = sjisEncode(s);
  if (r.unencodable.length > 0) throw new Error(`test fixture unencodable: ${r.unencodable}`);
  return r.bytes;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const LF = Uint8Array.of(0x0a);

/** ブラウザのフォーム送信を模擬する (textarea の値は CRLF 化されて送られる) */
const asBrowserSubmit = (value: string): string => value.replaceAll("\n", "\r\n");

describe("parseEditedText (§8)", () => {
  it("空文字は空ドキュメント", () => {
    expect(parseEditedText("")).toEqual({ lines: [], trailingNewline: false });
  });
  it("末尾改行なし", () => {
    expect(parseEditedText("a")).toEqual({ lines: ["a"], trailingNewline: false });
  });
  it("CRLF の末尾改行あり", () => {
    expect(parseEditedText("a\r\n")).toEqual({ lines: ["a"], trailingNewline: true });
  });
  it("空行 1 行だけのファイル", () => {
    expect(parseEditedText("\r\n")).toEqual({ lines: [""], trailingNewline: true });
  });
});

describe("mergeEditedText: 無編集の保全 (§8)", () => {
  it("Shift_JIS + CRLF + 末尾改行なしを無編集で往復してもバイト完全一致", () => {
    const original = cat(sjis("こんにちは"), Uint8Array.of(0x0d, 0x0a), sjis("世界"));
    const doc = decodeFile(original);
    const submitted = asBrowserSubmit(renderTextareaValue(doc));
    const merged = mergeEditedText(doc, submitted);
    expect(encodeDocument(merged)).toEqual(original);
  });

  it("混在改行 (CRLF と LF) も無編集なら行ごとに保全される", () => {
    const original = utf8("a\r\nb\n");
    const doc = decodeFile(original);
    // ブラウザは CRLF 化して送ってくるが、行テキストが同一なら元の改行を保持する
    const merged = mergeEditedText(doc, asBrowserSubmit(renderTextareaValue(doc)));
    expect(encodeDocument(merged)).toEqual(original);
  });

  it("NEC 選定 IBM 拡張の raw バイトは他行を編集しても変わらない", () => {
    // 0xED40 (ポインタ 8272) はデコードできるが、再エンコードすると IBM 拡張側
    // (0xFA-) になる重複マッピング。無編集行の raw 保持でのみバイト一致が保てる
    const necLine = Uint8Array.of(0xed, 0x40);
    const original = cat(necLine, LF, sjis("abc"), LF);
    const doc = decodeFile(original);
    const submitted = asBrowserSubmit(renderTextareaValue(doc)).replace("abc", "xyz");
    const merged = mergeEditedText(doc, submitted);
    expect(merged.lines[0]?.raw).toBe(doc.lines[0]?.raw);
    expect(encodeDocument(merged)).toEqual(cat(necLine, LF, sjis("xyz"), LF));
  });

  it("Shift_JIS の 1 行編集で他行の raw バイトが完全一致のまま残る", () => {
    const original = cat(sjis("一行目"), LF, sjis("二行目"), LF, sjis("三行目"), LF);
    const doc = decodeFile(original);
    const submitted = asBrowserSubmit(renderTextareaValue(doc)).replace("二行目", "書換え");
    const merged = mergeEditedText(doc, submitted);
    expect(encodeDocument(merged)).toEqual(cat(sjis("一行目"), LF, sjis("書換え"), LF, sjis("三行目"), LF));
    expect(merged.lines[0]?.raw).toBe(doc.lines[0]?.raw);
    expect(merged.lines[2]?.raw).toBe(doc.lines[2]?.raw);
    expect(merged.lines[1]?.raw).toBeNull();
  });
});

describe("mergeEditedText: 末尾改行・空ファイル・BOM (§8)", () => {
  it("末尾改行を追加できる", () => {
    const doc = decodeFile(utf8("a"));
    expect(encodeDocument(mergeEditedText(doc, "a\r\n"))).toEqual(utf8("a\n"));
  });

  it("末尾改行を除去できる", () => {
    const doc = decodeFile(utf8("a\n"));
    expect(encodeDocument(mergeEditedText(doc, "a"))).toEqual(utf8("a"));
  });

  it("空ファイルに行を追加できる", () => {
    const doc = decodeFile(new Uint8Array(0));
    expect(encodeDocument(mergeEditedText(doc, "new\r\n"))).toEqual(utf8("new\n"));
  });

  it("BOM 付きファイルを空にすると BOM だけが残る", () => {
    const doc = decodeFile(cat(BOM, utf8("hello\n")));
    expect(encodeDocument(mergeEditedText(doc, ""))).toEqual(BOM);
  });

  it("CRLF 支配のファイルへの挿入行は CRLF になる", () => {
    const doc = decodeFile(utf8("a\r\nb\r\n"));
    const merged = mergeEditedText(doc, "a\r\nb\r\nc\r\n");
    expect(encodeDocument(merged)).toEqual(utf8("a\r\nb\r\nc\r\n"));
  });
});

describe("browserEditBlockReason (§4.3)", () => {
  it("通常のファイルは編集可", () => {
    expect(browserEditBlockReason(decodeFile(utf8("a\nb\n")))).toBeNull();
  });
  it("CR のみの改行を含む行は編集不可", () => {
    expect(browserEditBlockReason(decodeFile(utf8("a\rb\n")))).not.toBeNull();
  });
  it("NUL を含む行は編集不可", () => {
    expect(browserEditBlockReason(decodeFile(utf8("a\u0000\n")))).not.toBeNull();
  });
});

describe("findMergeUnencodable (§8)", () => {
  it("Shift_JIS で表現できない文字を編集行から列挙する", () => {
    const doc = decodeFile(cat(sjis("日本語"), LF));
    const merged = mergeEditedText(doc, "日本語€\r\n");
    expect(findMergeUnencodable(merged)).toEqual(["€"]);
  });

  it("UTF-8 ドキュメントは常に空", () => {
    const doc = decodeFile(utf8("a\n"));
    const merged = mergeEditedText(doc, "€\r\n");
    expect(findMergeUnencodable(merged)).toEqual([]);
  });

  it("無編集行 (raw あり) は検査対象にしない", () => {
    const doc = decodeFile(cat(sjis("日本語"), LF));
    const merged = mergeEditedText(doc, "日本語\r\n");
    expect(findMergeUnencodable(merged)).toEqual([]);
  });
});
