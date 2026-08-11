import { describe, expect, it } from "vitest";
import {
  invalidPathReason,
  planChangeSet,
  type FileState,
  type NewFileConfig,
} from "../src/core/applier.ts";
import { sjisEncode } from "../src/core/sjis.ts";
import type { ChangeSet, FileChange, ReplaceBlock } from "../src/types.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sjis = (s: string): Uint8Array => sjisEncode(s).bytes;

const NEW_FILE: NewFileConfig = { encoding: "utf8", eol: "lf" };

const block = (search: string[], replace: string[], index = 1): ReplaceBlock => ({
  search,
  replace,
  line: 1,
  index,
});

const cs = (...files: FileChange[]): ChangeSet => ({ header: "概要", files });

const state = (bytes: Uint8Array | null, symlink = false): FileState => ({
  exists: bytes !== null || symlink,
  symlink,
  bytes,
});

const states = (m: Record<string, FileState>): Map<string, FileState> =>
  new Map(Object.entries(m));

describe("invalidPathReason (§9)", () => {
  it("正常な相対パスは null", () => {
    expect(invalidPathReason("src/utils/date.ts")).toBeNull();
  });
  it("絶対パス・ドライブレター・UNC・..・~ を拒否する", () => {
    expect(invalidPathReason("/etc/passwd")).not.toBeNull();
    expect(invalidPathReason("C:/Windows/system.ini")).not.toBeNull();
    expect(invalidPathReason("\\\\server/share/x")).not.toBeNull();
    expect(invalidPathReason("../outside.ts")).not.toBeNull();
    expect(invalidPathReason("src/../../outside.ts")).not.toBeNull();
    expect(invalidPathReason("~/x.ts")).not.toBeNull();
  });
});

describe("planChangeSet: replace", () => {
  it("Shift_JIS + CRLF ファイルへの適用で無変更行のバイトを維持する", () => {
    const original = sjis("' 変更しない行\r\nDim a As Integer = 1\r\n' 最後の行\r\n");
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "a.vb",
        line: 1,
        blocks: [block(["Dim a As Integer = 1"], ["Dim a As Integer = 2"])],
      }),
      states({ "a.vb": state(original) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.afterBytes).toEqual(
      sjis("' 変更しない行\r\nDim a As Integer = 2\r\n' 最後の行\r\n"),
    );
  });

  it("対象ファイルなし → target-missing", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "no.ts", line: 1, blocks: [block(["x"], ["y"])] }),
      states({}),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("target-missing");
  });

  it("SEARCH 未発見 → block-not-found (block 付き)", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "a.ts", line: 1, blocks: [block(["missing"], ["y"])] }),
      states({ "a.ts": state(utf8("hello\n")) }),
      NEW_FILE,
    );
    expect(plan.failures[0]).toMatchObject({ kind: "block-not-found" });
    expect(plan.failures[0]?.block?.search).toEqual(["missing"]);
    expect(plan.outcomes[0]?.afterBytes).toBeNull();
  });

  it("複数一致 → block-ambiguous", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "a.ts", line: 1, blocks: [block(["dup"], ["y"])] }),
      states({ "a.ts": state(utf8("dup\ndup\n")) }),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("block-ambiguous");
    expect(plan.failures[0]?.message).toContain("2 箇所");
  });

  it("Shift_JIS ファイルへ変換不能文字を書く REPLACE → unencodable (検証段階・§8)", () => {
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "a.vb",
        line: 1,
        blocks: [block(["日本語"], ["絵文字 🎉"])],
      }),
      states({ "a.vb": state(sjis("日本語\r\n")) }),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("unencodable");
    expect(plan.failures[0]?.message).toContain("🎉");
  });

  it("一部ブロック失敗でも成功分は計画に残る (--partial 用)", () => {
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "a.ts",
        line: 1,
        blocks: [block(["one"], ["ONE"], 1), block(["missing"], ["X"], 2)],
      }),
      states({ "a.ts": state(utf8("one\ntwo\n")) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    expect(plan.outcomes[0]?.appliedBlocks).toHaveLength(1);
    expect(plan.outcomes[0]?.afterBytes).toEqual(utf8("ONE\ntwo\n"));
  });

  it("シンボリックリンク → symlink エラー (§9)", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "link.ts", line: 1, blocks: [block(["x"], ["y"])] }),
      states({ "link.ts": state(null, true) }),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("symlink");
  });

  it("デコード不能ファイル → undecodable", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "bin.dat", line: 1, blocks: [block(["x"], ["y"])] }),
      states({ "bin.dat": state(Uint8Array.of(0x41, 0x80, 0x42)) }),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("undecodable");
  });
});

describe("planChangeSet: create / rewrite / delete", () => {
  it("create は newFile 設定 (utf8/lf) で末尾改行付きのバイト列を作る", () => {
    const plan = planChangeSet(
      cs({ op: "create", path: "new.ts", line: 1, content: ["const a = 1;"] }),
      states({}),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.afterBytes).toEqual(utf8("const a = 1;\n"));
  });

  it("create は config 上書き (shift_jis/crlf) に従う (§8)", () => {
    const plan = planChangeSet(
      cs({ op: "create", path: "new.vb", line: 1, content: ["' 日本語"] }),
      states({}),
      { encoding: "shift_jis", eol: "crlf" },
    );
    expect(plan.outcomes[0]?.afterBytes).toEqual(sjis("' 日本語\r\n"));
  });

  it("create で既存ファイルあり → target-exists (§3.2)", () => {
    const plan = planChangeSet(
      cs({ op: "create", path: "a.ts", line: 1, content: ["x"] }),
      states({ "a.ts": state(utf8("exists")) }),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("target-exists");
  });

  it("rewrite は元ファイルのエンコーディング・BOM・EOL・末尾改行を維持する (§8)", () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    const original = new Uint8Array([...bom, ...utf8("old\r\nbody")]); // BOM + CRLF + 末尾改行なし
    const plan = planChangeSet(
      cs({ op: "rewrite", path: "a.ts", line: 1, content: ["new1", "new2"] }),
      states({ "a.ts": state(original) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.afterBytes).toEqual(
      new Uint8Array([...bom, ...utf8("new1\r\nnew2")]),
    );
  });

  it("rewrite で対象なし → target-missing (§3.2)", () => {
    const plan = planChangeSet(
      cs({ op: "rewrite", path: "no.ts", line: 1, content: ["x"] }),
      states({}),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("target-missing");
  });

  it("delete は afterBytes なしで成功、対象なしなら適用済み扱い (冪等性)", () => {
    const ok = planChangeSet(
      cs({ op: "delete", path: "a.ts", line: 1 }),
      states({ "a.ts": state(utf8("x")) }),
      NEW_FILE,
    );
    expect(ok.ok).toBe(true);
    expect(ok.outcomes[0]?.afterBytes).toBeNull();
    expect(ok.outcomes[0]?.alreadyApplied).toBe(false);

    const gone = planChangeSet(cs({ op: "delete", path: "no.ts", line: 1 }), states({}), NEW_FILE);
    expect(gone.ok).toBe(true);
    expect(gone.outcomes[0]?.alreadyApplied).toBe(true);
  });

  it("パス不正はどの操作でも path-invalid (§9)", () => {
    const plan = planChangeSet(
      cs({ op: "delete", path: "../escape.ts", line: 1 }),
      states({}),
      NEW_FILE,
    );
    expect(plan.failures[0]?.kind).toBe("path-invalid");
  });
});

describe("planChangeSet: 適用済み検出 (冪等性)", () => {
  it("SEARCH 不一致でも REPLACE がまるごと存在すれば成功扱いでスキップ (書き込みなし)", () => {
    const original = utf8("before\nDim a As Integer = 2\nafter\n");
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "a.vb",
        line: 1,
        blocks: [block(["Dim a As Integer = 1"], ["Dim a As Integer = 2"])],
      }),
      states({ "a.vb": state(original) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.failures).toEqual([]);
    const o = plan.outcomes[0];
    expect(o?.afterBytes).toBeNull();
    expect(o?.appliedBlocks).toHaveLength(0);
    expect(o?.alreadyAppliedBlocks).toHaveLength(1);
    expect(o?.alreadyApplied).toBe(true);
  });

  it("行内の連続空白差 (コメント前の空白数) があっても適用済みと判定する", () => {
    const original = sjis("wk_ItemSet.Add(c)   ' コメント\r\n");
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "a.vb",
        line: 1,
        blocks: [block(["wk_ItemSet.Add(a)"], ["wk_ItemSet.Add(c) ' コメント"])],
      }),
      states({ "a.vb": state(original) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.alreadyAppliedBlocks[0]?.stage).toBe("ws-collapse");
  });

  it("適用済みブロックと未適用ブロックの混在: 未適用分だけ書き込む", () => {
    const original = utf8("Dim a = 2\nDim b = 1\n");
    const plan = planChangeSet(
      cs({
        op: "replace",
        path: "a.vb",
        line: 1,
        blocks: [
          block(["Dim a = 1"], ["Dim a = 2"], 1), // 適用済み
          block(["Dim b = 1"], ["Dim b = 2"], 2), // 未適用
        ],
      }),
      states({ "a.vb": state(original) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.alreadyApplied).toBe(false);
    expect(plan.outcomes[0]?.alreadyAppliedBlocks.map((b) => b.block.index)).toEqual([1]);
    expect(plan.outcomes[0]?.appliedBlocks.map((b) => b.block.index)).toEqual([2]);
    expect(plan.outcomes[0]?.afterBytes).toEqual(utf8("Dim a = 2\nDim b = 2\n"));
  });

  it("SEARCH も REPLACE も見つからない → 失敗 + 基準スナップショットずれのヒント", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "a.ts", line: 1, blocks: [block(["zzz"], ["yyy"])] }),
      states({ "a.ts": state(utf8("a\nb\n")) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.message).toContain("基準スナップショット");
  });

  it("REPLACE が空 (削除ブロック) は適用済み判定の対象外 → 従来どおり失敗 (ヒントなし)", () => {
    const plan = planChangeSet(
      cs({ op: "replace", path: "a.ts", line: 1, blocks: [block(["zzz"], [])] }),
      states({ "a.ts": state(utf8("a\nb\n")) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(false);
    expect(plan.failures[0]?.message).toContain("見つかりません");
    expect(plan.failures[0]?.message).not.toContain("基準スナップショット");
  });

  it("rewrite: 全文が現在の内容と一致すれば適用済み (書き込みなし)", () => {
    const plan = planChangeSet(
      cs({ op: "rewrite", path: "a.ts", line: 1, content: ["line1", "line2"] }),
      states({ "a.ts": state(utf8("line1\nline2\n")) }),
      NEW_FILE,
    );
    expect(plan.ok).toBe(true);
    expect(plan.outcomes[0]?.alreadyApplied).toBe(true);
    expect(plan.outcomes[0]?.afterBytes).toBeNull();
  });

  it("create: 既存ファイルの内容が一致すれば適用済み、違えば従来どおり target-exists", () => {
    const same = planChangeSet(
      cs({ op: "create", path: "a.ts", line: 1, content: ["const x = 1;"] }),
      states({ "a.ts": state(utf8("const x = 1;\n")) }),
      NEW_FILE,
    );
    expect(same.ok).toBe(true);
    expect(same.outcomes[0]?.alreadyApplied).toBe(true);

    const diff = planChangeSet(
      cs({ op: "create", path: "a.ts", line: 1, content: ["const x = 2;"] }),
      states({ "a.ts": state(utf8("const x = 1;\n")) }),
      NEW_FILE,
    );
    expect(diff.failures[0]?.kind).toBe("target-exists");
  });
});
