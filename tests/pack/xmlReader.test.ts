/**
 * xmlReader(.vbproj を読む自前の XML 読み取り)のテスト。
 * 返す形は以前使っていた fast-xml-parser(vbprojParser の設定)と同じ(2026-11-01 に 2 万通りの XML で比べて確認)。
 */
import { assert, describe, it } from "vitest";
import { parseXml } from "../../src/pack/xmlReader.ts";

function read(xml: string): unknown {
  const result = parseXml(xml);
  return result.ok ? result.document : `ERROR: ${result.message} (${result.line})`;
}

describe("xmlReader: 返す形", () => {
  it("子要素も属性もない要素は文字列", () => {
    assert.deepStrictEqual(read("<A/>"), { A: "" });
    assert.deepStrictEqual(read("<A></A>"), { A: "" });
    assert.deepStrictEqual(read("<A> x </A>"), { A: "x" });
  });

  it("属性は @_ 接頭辞、値の前後の空白は落とす。キーは子要素 → #text → 属性の順", () => {
    assert.deepStrictEqual(read('<A x=" 1 "/>'), { A: { "@_x": "1" } });
    const value = read('<A x="1"> t <B/></A>') as { A: Record<string, unknown> };
    assert.deepStrictEqual(Object.keys(value.A), ["B", "#text", "@_x"]);
  });

  it("同じ名前の子要素は配列", () => {
    assert.deepStrictEqual(read("<A><B>1</B><B>2</B><C/></A>"), { A: { B: ["1", "2"], C: "" } });
  });

  it("名前空間の接頭辞を外し、xmlns 属性は落とす", () => {
    assert.deepStrictEqual(read('<n:A xmlns:n="u" n:x="1" xmlns="v"><n:B/></n:A>'), {
      A: { B: "", "@_x": "1" },
    });
  });

  it("宣言・コメントは読み飛ばし、CDATA はそのまま。コメントではテキストを区切らない", () => {
    assert.deepStrictEqual(read('<?xml version="1.0"?><A><!-- c --><![CDATA[ x<y ]]></A>'), { A: " x<y " });
    assert.deepStrictEqual(read("<A>a<!-- c -->\r\n  b\r\n</A>"), { A: "a\n  b" });
  });

  it("5 つの実体参照だけを戻す(数値文字参照は戻さない)", () => {
    assert.deepStrictEqual(read('<A x="&lt;&amp;&#65;">&lt;&#65;&apos;&gt;</A>'), {
      A: { "#text": "<&#65;'>", "@_x": "<&&#65;" },
    });
  });

  it("改行は LF にそろえる", () => {
    assert.deepStrictEqual(read('<A x="a\r\nb">\r\n  a\r\n  b\r\n</A>'), { A: { "#text": "a\n  b", "@_x": "a\nb" } });
  });
});

describe("xmlReader: 壊れた XML", () => {
  it("対応しない閉じタグ・閉じていないタグは行番号つきのエラー", () => {
    const broken = parseXml("<Project>\n  <ItemGroup>\n    <Compile Include=\"a.vb\">\n  </ItemGroup>\n</Project>");
    assert.isFalse(broken.ok);
    if (!broken.ok) {
      assert.strictEqual(broken.line, 4);
      assert.include(broken.message, "</ItemGroup>");
    }
    assert.isFalse(parseXml("<A>").ok);
    assert.isFalse(parseXml("<A></B>").ok);
  });

  it("引用符のない属性値・重複した属性・ルート要素の前の文字・実体参照になっていない & はエラー", () => {
    assert.isFalse(parseXml("<A x=1/>").ok);
    assert.isFalse(parseXml('<A x="1" x="2"/>').ok);
    assert.isFalse(parseXml("text<A/>").ok);
    assert.isFalse(parseXml("<A>a & b</A>").ok);
  });

  it("ルート要素の後ろの文字は読み飛ばす", () => {
    assert.deepStrictEqual(read("<A/>x"), { A: "" });
  });
});
