/**
 * docs(docs/ 連携)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { DOC_TEMPLATES } from "../../src/pack/assets/docTemplates.ts";
import {
  allDocs,
  decideMode,
  describeDocs,
  type DocsDeps,
  missingDocNotes,
  parseDesignStatus,
  promptDocs,
  promptTemplateKinds,
  renderDocsBlock,
  renderTemplatesBlock,
  resolveDocs,
} from "../../src/pack/docs.ts";
import { DEFAULT_DOCS_CONFIG } from "../../src/pack/assets/docTemplates.ts";

const ROOT = path.resolve("/work/repo");
const CONFIG = { ...DEFAULT_DOCS_CONFIG };

function fakeDeps(files: Record<string, string>): DocsDeps {
  const map = new Map(
    Object.entries(files).map(([p, content]) => [path.resolve(ROOT, p), content]),
  );
  return {
    readTextFile: (p) => map.get(path.resolve(p)),
    listFileNames: (dir) => {
      const abs = path.resolve(dir);
      const names = [...map.keys()]
        .filter((k) => path.dirname(k) === abs)
        .map((k) => path.basename(k));
      return names.length === 0 ? undefined : names;
    },
  };
}

const DRAFT = "<!-- slnmix design: status=draft blocking=1 deferred=2 -->\n# 設計書\n";
const READY = "<!-- slnmix design: status=ready blocking=0 deferred=1 -->\n# 設計書\n";

suite("docs: parseDesignStatus", () => {
  test("1 行目の状態行を読む(BOM・空白・大文字小文字のキーを許容)", () => {
    assert.deepStrictEqual(parseDesignStatus(DRAFT), {
      status: "draft",
      blocking: 1,
      deferred: 2,
    });
    assert.deepStrictEqual(
      parseDesignStatus("﻿  <!--  slnmix design:  Status=ready   BLOCKING=0 -->  \r\n# x"),
      { status: "ready", blocking: 0, deferred: 0 },
    );
  });

  test("先頭 3 行以内なら見つける。4 行目以降は見ない", () => {
    assert.ok(parseDesignStatus(`# 見出し\n\n${DRAFT}`) !== undefined);
    assert.strictEqual(parseDesignStatus(`a\nb\nc\n${DRAFT}`), undefined);
  });

  test("status が draft / ready 以外、数値でない件数は undefined(推測しない)", () => {
    assert.strictEqual(
      parseDesignStatus("<!-- slnmix design: status=done blocking=0 -->"),
      undefined,
    );
    assert.strictEqual(
      parseDesignStatus("<!-- slnmix design: status=draft blocking=many -->"),
      undefined,
    );
    assert.strictEqual(parseDesignStatus("# 状態行なし\n"), undefined);
  });
});

suite("docs: resolveDocs", () => {
  test("design / spec の *.md を名前順に読み、handoff は 1 ファイル。ひな型は内蔵", () => {
    const docs = resolveDocs(
      ROOT,
      CONFIG,
      fakeDeps({
        "docs/design/b.md": READY,
        "docs/design/a.md": DRAFT,
        "docs/design/_draft.md": "無視(アンダースコア始まり)",
        "docs/design/notes.txt": "無視(md 以外)",
        "docs/spec/a.md": "# 仕様書\n",
        "docs/HANDOFF.md": "# 引継ぎ\n",
      }),
    );
    assert.deepStrictEqual(
      docs.design.map((d) => [d.relativePath, d.status?.status]),
      [
        ["docs/design/a.md", "draft"],
        ["docs/design/b.md", "ready"],
      ],
    );
    assert.strictEqual(docs.design[0]?.absolutePath, path.join(ROOT, "docs", "design", "a.md"));
    assert.deepStrictEqual(
      docs.spec.map((d) => d.relativePath),
      ["docs/spec/a.md"],
    );
    assert.strictEqual(docs.handoff?.relativePath, "docs/HANDOFF.md");
    assert.strictEqual(docs.handoff?.content, "# 引継ぎ\n");
    assert.strictEqual(docs.templates.design.source, "builtin");
    assert.strictEqual(docs.templates.design.content, DOC_TEMPLATES.design);
    assert.deepStrictEqual(docs.diagnostics, []);
    assert.strictEqual(allDocs(docs).length, 4);
  });

  test("ディレクトリがなくてもエラーにしない(空)", () => {
    const docs = resolveDocs(ROOT, CONFIG, fakeDeps({}));
    assert.deepStrictEqual(docs.design, []);
    assert.deepStrictEqual(docs.spec, []);
    assert.strictEqual(docs.handoff, undefined);
    assert.deepStrictEqual(docs.diagnostics, []);
  });

  test("状態行のない設計書は警告し、status なし(ready 扱い)で読む", () => {
    const docs = resolveDocs(
      ROOT,
      CONFIG,
      fakeDeps({ "docs/design/legacy.md": "# 旧設計書\n" }),
    );
    assert.strictEqual(docs.design[0]?.status, undefined);
    assert.strictEqual(docs.diagnostics.length, 1);
    assert.ok(docs.diagnostics[0]?.message.includes("状態行がありません"));
  });

  test("docs/templates/<kind>.md があれば内蔵ひな型を置き換える", () => {
    const docs = resolveDocs(
      ROOT,
      CONFIG,
      fakeDeps({ "docs/templates/handoff.md": "# 独自の引継ぎ書\n" }),
    );
    assert.deepStrictEqual(docs.templates.handoff, {
      content: "# 独自の引継ぎ書\n",
      source: "file",
    });
    assert.strictEqual(docs.templates.spec.source, "builtin");
    assert.ok(describeDocs(docs).includes("ひな型の上書き: handoff"));
  });

  test("設定で場所を変えられる", () => {
    const docs = resolveDocs(
      ROOT,
      { design: "doc/設計", spec: "doc/仕様", handoff: "doc/引継ぎ.md" },
      fakeDeps({ "doc/設計/x.md": READY, "doc/引継ぎ.md": "h\n" }),
    );
    assert.strictEqual(docs.design[0]?.relativePath, "doc/設計/x.md");
    assert.strictEqual(docs.handoff?.relativePath, "doc/引継ぎ.md");
  });
});

suite("docs: decideMode(自動選択)", () => {
  const decide = (files: Record<string, string>, input = {}) =>
    decideMode(resolveDocs(ROOT, CONFIG, fakeDeps(files)), input);

  test("設計書なし → design(新規作成)", () => {
    const r = decide({});
    assert.strictEqual(r.kind, "decided");
    if (r.kind !== "decided") return;
    assert.strictEqual(r.decision.mode, "design");
    assert.strictEqual(r.decision.currentDesign, undefined);
    assert.ok(r.decision.reason.includes("新規作成"));
    assert.ok(r.decision.defaultTask.includes("新しい設計書"));
  });

  test("draft の設計書が 1 件 → design(継続)、既定タスクに未回答件数", () => {
    const r = decide({ "docs/design/a.md": DRAFT });
    assert.strictEqual(r.kind, "decided");
    if (r.kind !== "decided") return;
    assert.strictEqual(r.decision.mode, "design");
    assert.strictEqual(r.decision.currentDesign?.relativePath, "docs/design/a.md");
    assert.ok(r.decision.defaultTask.includes("必須 1 件 / 後回し 2 件"));
  });

  test("draft が 2 件以上 → エラー(--design を促す)", () => {
    const r = decide({ "docs/design/a.md": DRAFT, "docs/design/b.md": DRAFT });
    assert.strictEqual(r.kind, "error");
    assert.ok(r.kind === "error" && r.message.includes("--design"));
  });

  test("ready(後回しが残っていても)+ 引継ぎ書なし → full(最初のバッチ)", () => {
    const r = decide({ "docs/design/a.md": READY });
    assert.strictEqual(r.kind, "decided");
    if (r.kind !== "decided") return;
    assert.strictEqual(r.decision.mode, "full");
    assert.ok(r.decision.reason.includes("最初のバッチ"));
    assert.ok(r.decision.defaultTask.includes("後回し確認事項"));
  });

  test("ready + 引継ぎ書あり → full(続きから)、既定タスクは引継ぎ書を指す", () => {
    const r = decide({ "docs/design/a.md": READY, "docs/HANDOFF.md": "h\n" });
    assert.strictEqual(r.kind, "decided");
    if (r.kind !== "decided") return;
    assert.strictEqual(r.decision.mode, "full");
    assert.ok(r.decision.reason.includes("続きから"));
    assert.ok(r.decision.defaultTask.includes("docs/HANDOFF.md"));
  });

  test("仕様書がなければ実装モードの既定タスクの先頭に初版作成を足す(あれば足さない)", () => {
    const without = decide({ "docs/design/a.md": READY, "docs/HANDOFF.md": "h\n" });
    assert.ok(without.kind === "decided" && without.decision.defaultTask.startsWith("仕様書がまだないため"));
    assert.ok(without.kind === "decided" && without.decision.defaultTask.includes("docs/HANDOFF.md"));
    const withSpec = decide({ "docs/design/a.md": READY, "docs/spec/a.md": "s\n" });
    assert.ok(withSpec.kind === "decided" && !withSpec.decision.defaultTask.includes("仕様書がまだない"));
  });

  test("状態行のない設計書は ready 扱い → full", () => {
    const r = decide({ "docs/design/legacy.md": "# 旧\n" });
    assert.ok(r.kind === "decided" && r.decision.mode === "full");
  });

  test("--mode 明示は自動選択より優先(design 以外)。--design との併用はエラー", () => {
    const r = decide({ "docs/design/a.md": DRAFT }, { explicitMode: "plan" });
    assert.ok(r.kind === "decided" && r.decision.mode === "plan" && r.decision.reason === "指定");
    const e = decide({}, { explicitMode: "full", designArg: "x" });
    assert.strictEqual(e.kind, "error");
  });

  test("--mode design + ready のみ → 新規作成の design", () => {
    const r = decide({ "docs/design/a.md": READY }, { explicitMode: "design" });
    assert.ok(r.kind === "decided" && r.decision.mode === "design");
    assert.ok(r.kind === "decided" && r.decision.currentDesign === undefined);
  });

  test("--design <既存名>(拡張子・ディレクトリの有無を問わない)→ その設計書を継続", () => {
    for (const arg of ["b", "b.md", "docs/design/b.md", "docs\\design\\b.md"]) {
      const r = decide({ "docs/design/a.md": DRAFT, "docs/design/b.md": READY }, { designArg: arg });
      assert.ok(r.kind === "decided", arg);
      if (r.kind !== "decided") return;
      assert.strictEqual(r.decision.mode, "design");
      assert.strictEqual(r.decision.currentDesign?.relativePath, "docs/design/b.md", arg);
    }
  });

  test("--design <新しい名前> → 新規作成先を設計ディレクトリ配下に決める", () => {
    const r = decide({ "docs/design/a.md": READY }, { designArg: "機種号機登録" });
    assert.ok(r.kind === "decided");
    if (r.kind !== "decided") return;
    assert.strictEqual(r.decision.mode, "design");
    assert.strictEqual(r.decision.newDesignPath, "docs/design/機種号機登録.md");
    assert.ok(r.decision.defaultTask.includes("docs/design/機種号機登録.md"));
  });
});

suite("docs: 出力", () => {
  test("renderDocsBlock: <doc> に path / kind と設計書の状態属性、変換関数を通す", () => {
    const docs = resolveDocs(
      ROOT,
      CONFIG,
      fakeDeps({ "docs/design/a.md": DRAFT, "docs/HANDOFF.md": 'pw = "secret"\n' }),
    );
    const block = renderDocsBlock(allDocs(docs), (t) => t.replace("secret", "[MASKED]"));
    assert.ok(block.startsWith("<docs>\n"));
    assert.ok(block.endsWith("</docs>\n"));
    assert.ok(
      block.includes(
        '<doc path="docs/design/a.md" kind="design" status="draft" blocking="1" deferred="2">\n<!-- slnmix design: status=draft blocking=1 deferred=2 -->\n# 設計書\n</doc>',
      ),
    );
    assert.ok(block.includes('<doc path="docs/HANDOFF.md" kind="handoff">\npw = "[MASKED]"\n</doc>'));
  });

  test("renderDocsBlock: 文書がなければ注記だけ。notes は先頭ヘッダに箇条書きで載る", () => {
    assert.ok(renderDocsBlock([]).includes("(文書はまだありません)"));
    const block = renderDocsBlock([], (t) => t, ["注記 A", "注記 B"]);
    assert.ok(block.includes("\n- 注記 A\n- 注記 B\n\n(文書はまだありません)"));
  });

  test("missingDocNotes: 仕様書・引継ぎ書がないことを実装モードでだけ明示し、設計書名からファイル名を決める", () => {
    const docs = resolveDocs(ROOT, CONFIG, fakeDeps({ "docs/design/機種号機登録.md": READY }));
    const notes = missingDocNotes(docs, "full");
    assert.strictEqual(notes.length, 2);
    assert.ok(notes[0]?.includes("docs/spec/機種号機登録.md の初版"));
    assert.ok(notes[1]?.includes("docs/HANDOFF.md を create"));
    const designNotes = missingDocNotes(docs, "design");
    assert.strictEqual(designNotes.length, 1);
    assert.ok(designNotes[0]?.includes("現状の仕様書(as-is)"));
    assert.ok(designNotes[0]?.includes("docs/spec/<画面名>.md"));
    const complete = resolveDocs(
      ROOT,
      CONFIG,
      fakeDeps({ "docs/design/a.md": READY, "docs/spec/a.md": "s\n", "docs/HANDOFF.md": "h\n" }),
    );
    assert.deepStrictEqual(missingDocNotes(complete, "full"), []);
    assert.deepStrictEqual(missingDocNotes(complete, "design"), []);
  });

  test("promptDocs: design モードは対象の設計書、それ以外は引継ぎ書だけ", () => {
    const docs = resolveDocs(
      ROOT,
      CONFIG,
      fakeDeps({ "docs/design/a.md": DRAFT, "docs/spec/a.md": "s\n", "docs/HANDOFF.md": "h\n" }),
    );
    const design = decideMode(docs, {});
    assert.ok(design.kind === "decided");
    if (design.kind !== "decided") return;
    assert.deepStrictEqual(
      promptDocs(docs, design.decision).map((d) => d.relativePath),
      ["docs/design/a.md"],
    );
    const full = decideMode(docs, { explicitMode: "full" });
    assert.ok(full.kind === "decided");
    if (full.kind !== "decided") return;
    assert.deepStrictEqual(
      promptDocs(docs, full.decision).map((d) => d.relativePath),
      ["docs/HANDOFF.md"],
    );
  });

  test("promptTemplateKinds / renderTemplatesBlock", () => {
    assert.deepStrictEqual(promptTemplateKinds("design"), ["design", "spec"]);
    assert.deepStrictEqual(promptTemplateKinds("full"), ["handoff", "spec"]);
    const docs = resolveDocs(ROOT, CONFIG, fakeDeps({}));
    const block = renderTemplatesBlock(docs, ["handoff"]);
    assert.ok(block.startsWith("<templates>\n"));
    assert.ok(block.includes('<template kind="handoff">\n# 引継ぎ書'));
    assert.ok(!block.includes('<template kind="spec">'));
    assert.ok(block.endsWith("</template>\n</templates>\n"));
  });
});
