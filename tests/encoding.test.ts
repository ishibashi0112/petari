import { describe, expect, it } from "vitest";
import {
  EncodingError,
  decodeFile,
  encodeDocument,
  findUnencodable,
  makeDocument,
} from "../src/core/encoding.ts";
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

describe("decodeFile: 検出", () => {
  it("UTF-8 (BOM なし) を検出する", () => {
    const doc = decodeFile(utf8("こんにちは\nworld\n"));
    expect(doc).toMatchObject({ encoding: "utf8", hasBom: false, eol: "lf", trailingNewline: true });
    expect(doc.lines.map((l) => l.text)).toEqual(["こんにちは", "world"]);
  });

  it("BOM 付き UTF-8 を検出する", () => {
    const doc = decodeFile(cat(BOM, utf8("abc\r\n")));
    expect(doc).toMatchObject({ encoding: "utf8", hasBom: true, eol: "crlf" });
  });

  it("Shift_JIS を検出する", () => {
    const doc = decodeFile(sjis("Private Sub 実行()\r\nEnd Sub\r\n"));
    expect(doc).toMatchObject({ encoding: "shift_jis", eol: "crlf", trailingNewline: true });
    expect(doc.lines.map((l) => l.text)).toEqual(["Private Sub 実行()", "End Sub"]);
  });

  it("半角カナの Shift_JIS ... ではなく UTF-8 優先の既知の限界ではないケースを検出する", () => {
    // 漢字を含む SJIS は UTF-8 として不正 → SJIS 判定
    const doc = decodeFile(sjis("ｶﾅと漢字"));
    expect(doc.encoding).toBe("shift_jis");
    expect(doc.lines[0]?.text).toBe("ｶﾅと漢字");
  });

  it("ASCII のみは UTF-8 と判定する (どちらで書いても同一バイト)", () => {
    expect(decodeFile(utf8("plain ascii\n")).encoding).toBe("utf8");
  });

  it("末尾改行なしを検出する", () => {
    const doc = decodeFile(utf8("a\nb"));
    expect(doc.trailingNewline).toBe(false);
    expect(doc.lines.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("空ファイル", () => {
    const doc = decodeFile(new Uint8Array(0));
    expect(doc.lines).toEqual([]);
    expect(doc.trailingNewline).toBe(false);
    expect(doc.eol).toBeNull();
  });

  it("改行 1 個だけのファイル", () => {
    const doc = decodeFile(utf8("\n"));
    expect(doc.lines.map((l) => l.text)).toEqual([""]);
    expect(doc.trailingNewline).toBe(true);
  });

  it("改行混在は多数派を支配的 EOL とし、各行の実改行を保持する", () => {
    const doc = decodeFile(utf8("a\r\nb\r\nc\n"));
    expect(doc.eol).toBe("crlf");
    expect(doc.lines.map((l) => l.eol)).toEqual(["crlf", "crlf", "lf"]);
  });

  it("UTF-16 BOM はエラー", () => {
    expect(() => decodeFile(Uint8Array.of(0xff, 0xfe, 0x41, 0x00))).toThrow(EncodingError);
    expect(() => decodeFile(Uint8Array.of(0xfe, 0xff, 0x00, 0x41))).toThrow(EncodingError);
  });

  it("UTF-8 でも Shift_JIS でもないバイト列はエラー", () => {
    // 0x80 単独は SJIS のリード/カナ範囲外かつ UTF-8 として不正
    expect(() => decodeFile(Uint8Array.of(0x41, 0x80, 0x42))).toThrow(EncodingError);
  });
});

describe("ラウンドトリップ (§8: 無変更なら完全にバイト一致)", () => {
  const cases: [string, Uint8Array][] = [
    ["UTF-8 + LF + 末尾改行あり", utf8("const a = 'あ';\nconst b = 2;\n")],
    ["UTF-8 + LF + 末尾改行なし", utf8("const a = 'あ';\nconst b = 2;")],
    ["UTF-8 + CRLF + 末尾改行あり", utf8("a\r\nあいう\r\n")],
    ["BOM 付き UTF-8 + CRLF", cat(BOM, utf8("x\r\ny\r\n"))],
    ["BOM 付き UTF-8 + 末尾改行なし", cat(BOM, utf8("x\r\ny"))],
    ["Shift_JIS + CRLF + 末尾改行あり", sjis("' コメント\r\nDim s As String = \"日本語\"\r\n")],
    ["Shift_JIS + CRLF + 末尾改行なし", sjis("Private Sub 処理()\r\nEnd Sub")],
    ["Shift_JIS + LF", sjis("日本語\nテスト\n")],
    ["Shift_JIS 半角カナ", sjis("ﾃｽﾄ ﾃﾞｰﾀ\r\n")],
    ["改行混在", utf8("a\r\nb\nc\r\n")],
    ["空ファイル", new Uint8Array(0)],
    ["改行のみ", utf8("\r\n")],
    ["NEC 特殊文字 (①)", sjis("①②㈱\r\n")],
  ];

  for (const [name, bytes] of cases) {
    it(name, () => {
      expect(encodeDocument(decodeFile(bytes))).toEqual(bytes);
    });
  }

  it("NEC 選定 IBM 拡張のバイト列 (0xED40) も無変更ならそのまま維持する", () => {
    // 0xED40 (纊) は IBM 拡張 0xFA5C と同じ文字。再エンコードすると 0xFA5C に
    // 変わってしまうが、raw 保持により無変更行はバイト維持される。
    const bytes = cat(Uint8Array.of(0xed, 0x40), utf8("\r\n"));
    const doc = decodeFile(bytes);
    expect(doc.encoding).toBe("shift_jis");
    expect(encodeDocument(doc)).toEqual(bytes);
  });
});

describe("行編集時の保全 (§8)", () => {
  it("変更した行だけ再エンコードし、他の行はバイト維持する", () => {
    const bytes = sjis("行一\r\n行二\r\n行三\r\n");
    const doc = decodeFile(bytes);
    doc.lines[1] = { text: "変更済", raw: null, eol: doc.lines[1]?.eol ?? null };
    expect(encodeDocument(doc)).toEqual(sjis("行一\r\n変更済\r\n行三\r\n"));
  });

  it("挿入行は支配的 EOL を使う (CRLF ファイル)", () => {
    const doc = decodeFile(sjis("a\r\nb\r\n"));
    doc.lines.splice(1, 0, { text: "inserted", raw: null, eol: null });
    expect(encodeDocument(doc)).toEqual(sjis("a\r\ninserted\r\nb\r\n"));
  });

  it("末尾改行なしファイルの最終行を置き換えても末尾改行なしを維持する", () => {
    const doc = decodeFile(utf8("a\nlast"));
    doc.lines[1] = { text: "LAST", raw: null, eol: null };
    expect(encodeDocument(doc)).toEqual(utf8("a\nLAST"));
  });

  it("BOM 付きファイルの編集で BOM を維持する", () => {
    const doc = decodeFile(cat(BOM, utf8("a\r\nb\r\n")));
    doc.lines[0] = { text: "A", raw: null, eol: "crlf" };
    expect(encodeDocument(doc)).toEqual(cat(BOM, utf8("A\r\nb\r\n")));
  });

  it("Shift_JIS ファイルへの変換不能文字はエンコード時に EncodingError", () => {
    const doc = decodeFile(sjis("あ\r\n"));
    doc.lines[0] = { text: "emoji 🎉", raw: null, eol: "crlf" };
    expect(() => encodeDocument(doc)).toThrow(EncodingError);
  });
});

describe("makeDocument (create 用・§8)", () => {
  it("既定 UTF-8/LF・末尾改行あり", () => {
    const doc = makeDocument(["a", "b"], { encoding: "utf8", eol: "lf" });
    expect(encodeDocument(doc)).toEqual(utf8("a\nb\n"));
  });

  it("Shift_JIS/CRLF の新規ファイル (config 上書き)", () => {
    const doc = makeDocument(["日本語"], { encoding: "shift_jis", eol: "crlf" });
    expect(encodeDocument(doc)).toEqual(sjis("日本語\r\n"));
  });

  it("空コンテンツなら空ファイル", () => {
    expect(encodeDocument(makeDocument([], { encoding: "utf8", eol: "lf" }))).toEqual(
      new Uint8Array(0),
    );
  });
});

describe("findUnencodable (§8: 検証段階のエラー検出)", () => {
  it("UTF-8 は常に空", () => {
    expect(findUnencodable("🎉€あ", "utf8")).toEqual([]);
  });

  it("Shift_JIS に無い文字を列挙する (重複除去)", () => {
    expect(findUnencodable("€ と 🎉 と €", "shift_jis")).toEqual(["€", "🎉"]);
  });

  it("日本語・記号・NEC 特殊文字・IBM 拡張は変換可能", () => {
    expect(findUnencodable("日本語 ｶﾅ ①㈱纊 Ⅴⅴ", "shift_jis")).toEqual([]);
  });
});

describe("sjisEncode の整合性", () => {
  it("エンコード → デコードで必ず元の文字列に戻る (全マッピング)", () => {
    const decoder = new TextDecoder("shift_jis");
    // テーブル全域: BMP の全文字を総当たりせず、エンコード可能な全マップ文字を検証
    let checked = 0;
    for (let cp = 0x80; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      const { bytes, unencodable } = sjisEncode(ch);
      if (unencodable.length > 0) continue;
      expect(decoder.decode(bytes)).toBe(ch === "¥" ? "\\" : ch === "‾" ? "~" : ch);
      checked++;
    }
    expect(checked).toBeGreaterThan(9000);
  });

  it("重複マッピング文字は Windows 慣習どおり NEC 選定 IBM 拡張 (0xED-) を避ける", () => {
    // 纊 は 0xED40 と 0xFA5C の両方にあるが、エンコードは 0xFA5C を選ぶ
    expect([...sjisEncode("纊").bytes]).toEqual([0xfa, 0x5c]);
  });

  it("ASCII と ¥ の扱い", () => {
    expect([...sjisEncode("A\\").bytes]).toEqual([0x41, 0x5c]);
    expect([...sjisEncode("¥").bytes]).toEqual([0x5c]);
  });
});
