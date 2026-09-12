import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixedNewFile,
  resolveNewFileStyle,
  type StyleSample,
  type StyleSampleGroup,
} from "../src/core/new-file-style.ts";
import { sjisEncode } from "../src/core/sjis.ts";
import { collectStyleSampleGroups } from "../src/infra/new-file-style.ts";

const sjisCrlf: StyleSample = { encoding: "shift_jis", bom: false, eol: "crlf" };
const utf8Lf: StyleSample = { encoding: "utf8", bom: false, eol: "lf" };
const utf8BomCrlf: StyleSample = { encoding: "utf8", bom: true, eol: "crlf" };
const group = (dir: string, sameExt: StyleSample[], others: StyleSample[] = []): StyleSampleGroup => ({
  dir,
  sameExt,
  others,
});

describe("resolveNewFileStyle (設計書 §11.2)", () => {
  it("auto 以外は従来どおり明示値 (eol 既定 lf / BOM なし)", () => {
    expect(resolveNewFileStyle("a.vb", { encoding: "utf8", eol: "lf" }, [])).toEqual({
      config: { encoding: "utf8", bom: false, eol: "lf" },
      basis: null,
    });
    expect(fixedNewFile({ encoding: "shift_jis" })).toEqual({ encoding: "shift_jis", bom: false, eol: "lf" });
  });

  it("同じディレクトリの同拡張子ファイルの多数決 (shift_jis/crlf)", () => {
    const r = resolveNewFileStyle("App/Services/New.vb", { encoding: "auto" }, [
      group("App/Services", [sjisCrlf, sjisCrlf, utf8BomCrlf]),
    ]);
    expect(r.config).toEqual({ encoding: "shift_jis", bom: false, eol: "crlf" });
    expect(r.basis).toContain("App/Services の .vb 3 ファイルの多数決");
    expect(r.basis).toContain("shift_jis / crlf");
  });

  it("同拡張子がなければ任意のテキスト、それもなければ上位ディレクトリの手本を使う", () => {
    const r = resolveNewFileStyle("App/Services/New.vb", { encoding: "auto" }, [
      group("App/Services", [], []),
      group("App", [], [utf8Lf, utf8Lf]),
    ]);
    expect(r.config.encoding).toBe("utf8");
    expect(r.config.eol).toBe("lf");
    expect(r.basis).toContain("App の テキスト 2 ファイル (同じ拡張子の手本なし)");
  });

  it("手本がなければ拡張子別の既定 (.vb → utf8 + BOM + crlf、それ以外 → utf8 / lf)", () => {
    expect(resolveNewFileStyle("App/New.vb", { encoding: "auto" }, [group("App", [])]).config).toEqual({
      encoding: "utf8",
      bom: true,
      eol: "crlf",
    });
    expect(resolveNewFileStyle("src/new.ts", { encoding: "auto" }, [group("src", [])]).config).toEqual({
      encoding: "utf8",
      bom: false,
      eol: "lf",
    });
  });

  it(".vb で utf8 かつ BOM なしになった場合は BOM を付ける (BOM なし UTF-8 の .vb を作らない)", () => {
    const r = resolveNewFileStyle("App/New.vb", { encoding: "auto" }, [group("App", [utf8Lf, utf8Lf])]);
    expect(r.config).toEqual({ encoding: "utf8", bom: true, eol: "lf" });
    expect(r.basis).toContain("BOM を付与");
    // .vb 以外は付けない
    const ts = resolveNewFileStyle("src/new.ts", { encoding: "auto" }, [group("src", [utf8Lf])]);
    expect(ts.config.bom).toBe(false);
  });

  it("明示された eol / bom は推定より優先する", () => {
    const r = resolveNewFileStyle("App/New.vb", { encoding: "auto", eol: "lf", bom: false }, [
      group("App", [sjisCrlf, utf8Lf, utf8Lf]),
    ]);
    expect(r.config).toEqual({ encoding: "utf8", bom: false, eol: "lf" });
  });
});

describe("collectStyleSampleGroups (infra)", () => {
  it("作成先ディレクトリの手本を集め、なければ上位へ辿る。バイナリ・ドットファイルは除外", () => {
    const root = mkdtempSync(join(tmpdir(), "petari-style-"));
    mkdirSync(join(root, "App", "Forms"), { recursive: true });
    writeFileSync(join(root, "App", "A.vb"), sjisEncode("' 日本語\r\n").bytes);
    writeFileSync(join(root, "App", "B.vb"), sjisEncode("' 日本語\r\n").bytes);
    writeFileSync(join(root, "App", "C.vb"), new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("' x\n")]));
    writeFileSync(join(root, "App", "readme.txt"), "text\n");
    writeFileSync(join(root, "App", "icon.bin"), new Uint8Array([0x00, 0x01, 0x02]));
    writeFileSync(join(root, "App", ".hidden"), "x\n");
    writeFileSync(join(root, "App", "Forms", "notes.md"), "notes\r\n");

    // 作成先 App/Forms/New.vb: 同ディレクトリに .vb がないので others (notes.md) を使う
    const forms = collectStyleSampleGroups(root, "App/Forms/New.vb");
    expect(forms).toHaveLength(1);
    expect(forms[0]?.dir).toBe("App/Forms");
    expect(forms[0]?.sameExt).toEqual([]);
    expect(forms[0]?.others).toEqual([{ encoding: "utf8", bom: false, eol: "crlf" }]);

    // 作成先 App/New.vb: 同ディレクトリの .vb 3 件 (バイナリとドットファイルは除外)
    const app = collectStyleSampleGroups(root, "App/New.vb");
    expect(app[0]?.sameExt).toHaveLength(3);
    expect(app[0]?.others).toHaveLength(1);

    // 未作成ディレクトリ App/Missing/Deep: 空グループを経て上位 App で見つかる
    const deep = collectStyleSampleGroups(root, "App/Missing/Deep/New.vb");
    expect(deep.map((g) => g.dir)).toEqual(["App/Missing/Deep", "App/Missing", "App"]);
    expect(deep[2]?.sameExt).toHaveLength(3);
  });
});
