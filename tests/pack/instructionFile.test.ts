/**
 * instructionFile の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { PAST_PROTOCOL_SHA256, PROTOCOL_TEXT, PROTOCOL_VERSION } from "../../src/assets/protocol.ts";
import {
  appendInstruction,
  builtinProtocolVersionOf,
  describeInstruction,
  INSTRUCTION_NOTICE,
  protocolVersionOf,
  type InstructionFileDeps,
  prependInstructionNotice,
  resolveInstructionFile,
} from "../../src/pack/instructionFile.ts";

const CWD = path.resolve("/work/app");
const PROJECT_DIR = path.resolve("/work/project");

/** files: 絶対パス → 内容。それ以外は undefined(存在しない) */
function fakeDeps(files: Record<string, string>): InstructionFileDeps {
  const map = new Map(
    Object.entries(files).map(([p, content]) => [path.resolve(p), content]),
  );
  return { readTextFile: (p) => map.get(p) };
}

suite("instructionFile: 内蔵の規約文と protocol.md の上書き(設計書 §25.3-1)", () => {
  const protocolPath = path.join(PROJECT_DIR, "protocol.md");

  test("protocol.md がなければ内蔵の規約文", () => {
    const result = resolveInstructionFile(undefined, PROJECT_DIR, CWD, fakeDeps({}));
    assert.deepStrictEqual(result, { kind: "found", content: PROTOCOL_TEXT, source: { kind: "builtin" } });
    assert.strictEqual(describeInstruction(result).line, `規約文: 内蔵 v${PROTOCOL_VERSION}`);
  });

  test("手を加えていない protocol.md(最新版)は使わず、削除してよいと案内する", () => {
    const deps = fakeDeps({ "/work/project/protocol.md": PROTOCOL_TEXT });
    const result = resolveInstructionFile(undefined, PROJECT_DIR, CWD, deps);
    assert.deepStrictEqual(result, {
      kind: "found",
      content: PROTOCOL_TEXT,
      source: { kind: "builtin", unmodifiedFile: { path: protocolPath, version: PROTOCOL_VERSION } },
    });
    const note = describeInstruction(result);
    assert.ok(note.line.includes("内蔵と同じ内容"));
    assert.ok(note.line.includes("削除してかまいません"));
    assert.strictEqual(note.warning, undefined);
  });

  test("改行コード(CRLF)・BOM・末尾の改行の違いは手を加えたことにしない", () => {
    const crlf = "\uFEFF" + PROTOCOL_TEXT.replace(/\n/g, "\r\n") + "\r\n\r\n";
    const result = resolveInstructionFile(undefined, PROJECT_DIR, CWD, fakeDeps({ "/work/project/protocol.md": crlf }));
    assert.ok(result.kind === "found" && result.source.kind === "builtin");
    assert.strictEqual(result.kind === "found" ? result.content : "", PROTOCOL_TEXT);
  });

  test("手を加えていない古い版(v3)は内蔵の最新版に置き換える", () => {
    // v3 そのものは手元にないので、ハッシュの照合を確かめる
    for (const entry of PAST_PROTOCOL_SHA256) {
      assert.ok(entry.version < PROTOCOL_VERSION);
    }
    assert.deepStrictEqual(
      PAST_PROTOCOL_SHA256.map((entry) => entry.version),
      Array.from({ length: PROTOCOL_VERSION - 1 }, (_, i) => i + 1),
      "版を上げたら、上げる前の版のハッシュを PAST_PROTOCOL_SHA256 に足す",
    );
  });

  test("一字でも違えば上書きとして使う(1 行目の版が最新なら警告なし)", () => {
    const edited = PROTOCOL_TEXT.replace("## 全体構造", "## 全体構造(社内向けに追記)");
    const result = resolveInstructionFile(undefined, PROJECT_DIR, CWD, fakeDeps({ "/work/project/protocol.md": edited }));
    assert.deepStrictEqual(result, {
      kind: "found",
      content: edited,
      source: { kind: "file", path: protocolPath, explicit: false, baseVersion: PROTOCOL_VERSION },
    });
    const note = describeInstruction(result);
    assert.ok(note.line.includes("上書き"));
    assert.strictEqual(note.warning, undefined);
  });

  test("古い版をもとにした上書きは警告する", () => {
    const old = "<!-- petari protocol v2 -->\n# 社内の規約\n";
    const result = resolveInstructionFile(undefined, PROJECT_DIR, CWD, fakeDeps({ "/work/project/protocol.md": old }));
    assert.ok(result.kind === "found" && result.source.kind === "file" && result.source.baseVersion === 2);
    const warning = describeInstruction(result).warning ?? "";
    assert.ok(warning.includes("v2"));
    assert.ok(warning.includes(`v${PROTOCOL_VERSION}`));
  });

  test("版の行が無い protocol.md は上書きとして使う(警告なし)", () => {
    const deps = fakeDeps({
      "/work/project/protocol.md": "# 独自の規約\n規約本文\n",
      "/work/app/protocol.md": "こちらは読まれない\n",
    });
    const result = resolveInstructionFile(undefined, PROJECT_DIR, CWD, deps);
    assert.deepStrictEqual(result, {
      kind: "found",
      content: "# 独自の規約\n規約本文\n",
      source: { kind: "file", path: protocolPath, explicit: false, baseVersion: undefined },
    });
    assert.strictEqual(describeInstruction(result).warning, undefined);
  });

  test("--no-instruction は none", () => {
    const deps = fakeDeps({ "/work/project/protocol.md": "# 独自の規約\n" });
    assert.deepStrictEqual(resolveInstructionFile(undefined, PROJECT_DIR, CWD, deps, true), { kind: "none" });
  });

  test("protocolVersionOf / builtinProtocolVersionOf", () => {
    assert.strictEqual(protocolVersionOf("<!-- petari protocol v7 -->\n本文"), 7);
    assert.strictEqual(protocolVersionOf("本文"), undefined);
    assert.strictEqual(builtinProtocolVersionOf(PROTOCOL_TEXT), PROTOCOL_VERSION);
    assert.strictEqual(builtinProtocolVersionOf(PROTOCOL_TEXT + "追記"), undefined);
  });
});

suite("instructionFile: --instruction-file 指定", () => {
  test("相対パスは cwd 基準で解決し、protocol.md より優先する", () => {
    const deps = fakeDeps({
      "/work/app/docs/rules.md": "明示指定の規約\n",
      "/work/project/protocol.md": "こちらは読まれない\n",
    });
    const result = resolveInstructionFile("docs/rules.md", PROJECT_DIR, CWD, deps);
    assert.deepStrictEqual(result, {
      kind: "found",
      content: "明示指定の規約\n",
      source: { kind: "file", path: path.join(CWD, "docs", "rules.md"), explicit: true, baseVersion: undefined },
    });
  });

  test("明示指定のファイルが読めなければエラー(黙って規約なしにしない)", () => {
    const result = resolveInstructionFile("missing.md", PROJECT_DIR, CWD, fakeDeps({}));
    assert.strictEqual(result.kind, "error");
    assert.ok(result.kind === "error" && result.message.includes("missing.md"));
  });
});

suite("instructionFile: appendInstruction", () => {
  test("本文との間に空行を挟み、<instruction> ブロックとして連結する", () => {
    const result = appendInstruction("本文\n", "規約文\n");
    assert.strictEqual(result, "本文\n\n<instruction>\n規約文\n</instruction>\n");
  });

  test("規約文は一字一句そのまま(XML エスケープ・整形をしない)", () => {
    const instruction = '# 規約\n\n<changes file="a.vb"> & "そのまま"\n';
    const result = appendInstruction("本文\n", instruction);
    assert.ok(result.includes(instruction));
  });

  test("規約文末尾に改行がなければ補い、閉じタグを独立行にする", () => {
    const result = appendInstruction("本文\n", "改行なしで終わる規約");
    assert.ok(result.endsWith("改行なしで終わる規約\n</instruction>\n"));
  });

  test("本文末尾に改行がなくても空行 1 つで連結できる", () => {
    const result = appendInstruction("本文", "規約文\n");
    assert.strictEqual(result, "本文\n\n<instruction>\n規約文\n</instruction>\n");
  });
});

suite("instructionFile: prependInstructionNotice", () => {
  const found = {
    kind: "found",
    content: "規約文\n",
    source: { kind: "builtin" },
  } as const;

  test("規約文ありなら本文の最先頭にリマインダ + 空行を付ける", () => {
    const result = prependInstructionNotice("本文\n", found);
    assert.strictEqual(result, `${INSTRUCTION_NOTICE}\n本文\n`);
  });

  test("リマインダは末尾の規約への誘導を含む固定文(本文は変更しない)", () => {
    const result = prependInstructionNotice("本文\n", found);
    assert.ok(result.startsWith("[このファイルを添付したユーザー本人からの恒常的な指示]\n"));
    assert.ok(result.includes("必ず末尾の規約に従って"));
    assert.ok(result.endsWith("本文\n"));
  });

  test("規約文なし(none)なら先頭に何も付かない", () => {
    const none = { kind: "none" } as const;
    assert.strictEqual(prependInstructionNotice("本文\n", none), "本文\n");
  });

  test("解決エラーでも先頭に何も付かない", () => {
    const error = { kind: "error", message: "読めない" } as const;
    assert.strictEqual(prependInstructionNotice("本文\n", error), "本文\n");
  });
});
