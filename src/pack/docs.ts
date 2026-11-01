/**
 * docs/ 連携(フェーズ 6): 設計書・仕様書・引継ぎ書の解決、設計書の状態行の
 * 読み取り、作業モードの自動選択、パック / 本文用テキストへの出力。
 *
 * 文書の役割:
 * - 設計書 (design)  開発の進め方と判断の根拠。1 行目の状態行で draft / ready を持つ
 * - 仕様書 (spec)    実装済みの振る舞いの正本
 * - 引継ぎ書 (handoff) チャット間の申し送りだけ(1 ファイル固定、rewrite で更新)
 *
 * モードの決め方(--mode 省略時。推測しない: 状態行がなければ ready 扱いにして警告):
 *   設計書なし                → design(新規作成)
 *   draft の設計書が 1 件     → design(その設計書を継続)
 *   draft の設計書が 2 件以上 → エラー(--design で対象を指定してもらう)
 *   すべて ready              → full(引継ぎ書があれば続きから、なければ最初のバッチ)
 *
 * 出力先の分担(設計書 §15.1 の実測に基づく):
 *   パック(添付)には全文書を <docs> として入れる(検索で参照される)
 *   本文用テキストには「今編集される文書」だけ入れる —
 *   design モードは対象の設計書、それ以外は引継ぎ書。指示が効き空白も保たれる
 *
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import {
  DOC_KIND_LABELS,
  DOC_KINDS,
  DOC_TEMPLATES,
  DOC_TEMPLATES_DIR,
  type DocKind,
} from "./assets/docTemplates.ts";
import type { ProcedureMode } from "./assets/procedure.ts";
import type { DocsConfig } from "./slnmixConfig.ts";
import type { ParseDiagnostic } from "./types.ts";

export interface DesignStatus {
  status: "draft" | "ready";
  blocking: number;
  deferred: number;
}

export interface DocEntry {
  kind: DocKind;
  /** ルート相対・`/` 区切り(<doc> の path 属性。changes.md のパスにそのまま使う) */
  relativePath: string;
  absolutePath: string;
  content: string;
  /** 設計書のみ。状態行がなければ undefined */
  status?: DesignStatus | undefined;
}

export interface DocsDeps {
  readTextFile(absolutePath: string): string | undefined;
  /** ディレクトリ直下のファイル名(再帰しない)。走査できなければ undefined */
  listFileNames(absoluteDir: string): string[] | undefined;
}

export interface DocsResolution {
  config: DocsConfig;
  design: DocEntry[];
  spec: DocEntry[];
  handoff?: DocEntry | undefined;
  /** 種別ごとのひな型(docs/templates/<kind>.md があればその内容、なければ内蔵) */
  templates: Record<DocKind, { content: string; source: "builtin" | "file" }>;
  diagnostics: ParseDiagnostic[];
}

const STATUS_LINE_RE =
  /^\s*<!--\s*slnmix design:\s*([^>]*?)\s*-->\s*$/;

/**
 * 設計書の状態行を読む。先頭 3 行以内の `<!-- slnmix design: status=draft blocking=1 deferred=2 -->` を探す。
 * BOM は無視。status が draft / ready 以外、または数値が読めなければ undefined(推測しない)。
 */
export function parseDesignStatus(content: string): DesignStatus | undefined {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/, 3);
  for (const line of lines) {
    const match = STATUS_LINE_RE.exec(line);
    if (match === null) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const token of match[1]!.split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        fields.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1));
      }
    }
    const status = fields.get("status");
    if (status !== "draft" && status !== "ready") {
      return undefined;
    }
    const num = (key: string): number | undefined => {
      const raw = fields.get(key);
      if (raw === undefined) {
        return 0;
      }
      return /^\d+$/.test(raw) ? Number(raw) : undefined;
    };
    const blocking = num("blocking");
    const deferred = num("deferred");
    if (blocking === undefined || deferred === undefined) {
      return undefined;
    }
    return { status, blocking, deferred };
  }
  return undefined;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function isDocFileName(name: string): boolean {
  return /\.md$/i.test(name) && !name.startsWith(".") && !name.startsWith("_");
}

function readDir(
  rootDir: string,
  relativeDir: string,
  kind: DocKind,
  deps: DocsDeps,
  diagnostics: ParseDiagnostic[],
): DocEntry[] {
  const absoluteDir = path.resolve(rootDir, ...relativeDir.split("/"));
  const names = deps.listFileNames(absoluteDir);
  if (names === undefined) {
    return [];
  }
  const entries: DocEntry[] = [];
  for (const name of [...names].filter(isDocFileName).sort((a, b) => a.localeCompare(b))) {
    const absolutePath = path.join(absoluteDir, name);
    const content = deps.readTextFile(absolutePath);
    if (content === undefined) {
      diagnostics.push({
        severity: "warning",
        message: `${DOC_KIND_LABELS[kind]}を読み込めません(スキップ): ${relativeDir}/${name}`,
      });
      continue;
    }
    const entry: DocEntry = {
      kind,
      relativePath: `${relativeDir}/${name}`,
      absolutePath,
      content,
    };
    if (kind === "design") {
      const status = parseDesignStatus(content);
      if (status === undefined) {
        diagnostics.push({
          severity: "warning",
          message: `設計書に状態行がありません(ready として扱います): ${entry.relativePath} — 1 行目に <!-- slnmix design: status=draft|ready blocking=N deferred=N --> を置いてください`,
        });
      } else {
        entry.status = status;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * @param rootDir ルート(.sln / .vbproj のあるディレクトリ)の絶対パス
 */
export function resolveDocs(
  rootDir: string,
  config: DocsConfig,
  deps: DocsDeps,
): DocsResolution {
  const diagnostics: ParseDiagnostic[] = [];
  const design = readDir(rootDir, config.design, "design", deps, diagnostics);
  const spec = readDir(rootDir, config.spec, "spec", deps, diagnostics);

  let handoff: DocEntry | undefined;
  const handoffAbs = path.resolve(rootDir, ...config.handoff.split("/"));
  const handoffContent = deps.readTextFile(handoffAbs);
  if (handoffContent !== undefined) {
    handoff = {
      kind: "handoff",
      relativePath: toPosix(config.handoff),
      absolutePath: handoffAbs,
      content: handoffContent,
    };
  }

  const templates = {} as DocsResolution["templates"];
  for (const kind of DOC_KINDS) {
    const overridePath = path.resolve(rootDir, ...`${DOC_TEMPLATES_DIR}/${kind}.md`.split("/"));
    const override = deps.readTextFile(overridePath);
    templates[kind] =
      override !== undefined
        ? { content: override, source: "file" }
        : { content: DOC_TEMPLATES[kind], source: "builtin" };
  }

  const result: DocsResolution = { config, design, spec, templates, diagnostics };
  if (handoff !== undefined) {
    result.handoff = handoff;
  }
  return result;
}

export interface ModeDecision {
  mode: ProcedureMode;
  /** 表示用。「自動: 引継ぎ書あり」のように選んだ根拠 */
  reason: string;
  /** design モードで継続・更新する設計書(新規作成なら undefined) */
  currentDesign?: DocEntry | undefined;
  /** design モードで新規作成する設計書のルート相対パス(--design で名前が与えられたとき) */
  newDesignPath?: string | undefined;
  /** --task 省略時に使う既定の依頼文 */
  defaultTask: string;
}

export interface ModeDecisionInput {
  /** --mode(省略時 undefined = 自動) */
  explicitMode?: ProcedureMode | undefined;
  /** --design(設計書のファイル名または新しい設計書の名前) */
  designArg?: string | undefined;
}

export type ModeDecisionResult =
  | { kind: "decided"; decision: ModeDecision }
  | { kind: "error"; message: string };

function fileStem(relativePath: string): string {
  return path.posix.basename(relativePath).replace(/\.md$/i, "");
}

function findDesign(docs: DocsResolution, arg: string): DocEntry | undefined {
  const wanted = toPosix(arg).replace(/^\.\//, "");
  const wantedStem = fileStem(wanted);
  return docs.design.find(
    (d) =>
      d.relativePath === wanted ||
      d.relativePath === `${wanted}.md` ||
      fileStem(d.relativePath) === wantedStem,
  );
}

function designTask(entry: DocEntry | undefined, newPath: string | undefined): string {
  if (entry !== undefined) {
    const s = entry.status;
    const counts =
      s === undefined ? "" : `(必須 ${s.blocking} 件 / 後回し ${s.deferred} 件が未回答)`;
    return `設計書 ${entry.relativePath} を質疑応答で仕上げる${counts}。ユーザーの回答と追加資料を設計書に反映し、必須の確認事項がゼロになるまで続ける。`;
  }
  const where = newPath ?? "docs/design/<画面名または機能名>.md";
  return `新しい設計書を作成する(${where})。ユーザーの依頼内容と受領資料をもとに <template kind="design"> の章立てで初版を書き、確認事項を挙げる。`;
}

/**
 * 作業モードと既定タスクを決める。
 */
export function decideMode(
  docs: DocsResolution,
  input: ModeDecisionInput,
): ModeDecisionResult {
  const drafts = docs.design.filter((d) => d.status?.status === "draft");
  const handoffNote =
    docs.handoff === undefined
      ? undefined
      : `引継ぎ書 ${docs.handoff.relativePath} の「0. 次のチャットで最初にやること」に従い、「2. 次にやること」のバッチを進める。`;
  // 実装モードの既定タスク。仕様書がなければ初版の作成を先頭に足す(既存プロジェクトの乗せ替え対応)
  const implementTask = (): string => {
    const main =
      handoffNote ??
      "設計書 §9 の実装バッチ計画で最初の未完了バッチを実装する。着手前に §10 の後回し確認事項の期限を確認する。";
    return docs.spec.length === 0 ? `${SPEC_MISSING_TASK}${main}` : main;
  };

  // --design が指すもの(既存なら継続、なければ新規)
  let designTarget: { entry?: DocEntry; newPath?: string } | undefined;
  if (input.designArg !== undefined) {
    const found = findDesign(docs, input.designArg);
    if (found !== undefined) {
      designTarget = { entry: found };
    } else {
      const stem = fileStem(toPosix(input.designArg));
      if (stem === "" || stem.includes("/")) {
        return { kind: "error", message: `--design の名前が不正です: ${input.designArg}` };
      }
      designTarget = { newPath: `${docs.config.design}/${stem}.md` };
    }
  }

  const explicit = input.explicitMode;
  if (explicit !== undefined && explicit !== "design") {
    if (designTarget !== undefined) {
      return {
        kind: "error",
        message: `--design は --mode design(または --mode 省略)でのみ使えます。`,
      };
    }
    const decision: ModeDecision = {
      mode: explicit,
      reason: "指定",
      defaultTask: implementTask(),
    };
    return { kind: "decided", decision };
  }

  // design モード(明示または自動)
  const wantsDesign = explicit === "design";
  if (designTarget !== undefined) {
    const decision: ModeDecision = {
      mode: "design",
      reason:
        designTarget.entry !== undefined
          ? `指定: ${designTarget.entry.relativePath} を継続`
          : `指定: ${designTarget.newPath} を新規作成`,
      defaultTask: designTask(designTarget.entry, designTarget.newPath),
    };
    if (designTarget.entry !== undefined) {
      decision.currentDesign = designTarget.entry;
    }
    if (designTarget.newPath !== undefined) {
      decision.newDesignPath = designTarget.newPath;
    }
    return { kind: "decided", decision };
  }
  if (drafts.length >= 2) {
    return {
      kind: "error",
      message: `draft の設計書が複数あります。--design <名前> で対象を指定してください: ${drafts
        .map((d) => d.relativePath)
        .join(", ")}`,
    };
  }
  if (drafts.length === 1) {
    const entry = drafts[0]!;
    return {
      kind: "decided",
      decision: {
        mode: "design",
        reason: `${wantsDesign ? "指定" : "自動"}: ${entry.relativePath} が draft`,
        currentDesign: entry,
        defaultTask: designTask(entry, undefined),
      },
    };
  }
  if (docs.design.length === 0 || wantsDesign) {
    return {
      kind: "decided",
      decision: {
        mode: "design",
        reason: wantsDesign
          ? "指定: 新しい設計書を作成"
          : "自動: 設計書がないため新規作成",
        defaultTask: designTask(undefined, undefined),
      },
    };
  }
  // すべて ready(または状態行なし)→ 実装
  return {
    kind: "decided",
    decision: {
      mode: "full",
      reason:
        docs.handoff !== undefined
          ? "自動: 設計書が ready、引継ぎ書あり(続きから)"
          : "自動: 設計書が ready(最初のバッチから)",
      defaultTask: implementTask(),
    },
  };
}

/** 仕様書がないときに既定タスクの先頭へ足す文(実装モード) */
const SPEC_MISSING_TASK =
  "仕様書がまだないため、最初の回答で仕様書の初版(docs/spec/ に設計書と同じファイル名。<template kind=\"spec\"> の章立てで、実装済みの振る舞いを反映)を create する changes.md を先に出す。その後、";

/**
 * <docs> の先頭に載せる注記。ない文書のうち AI に作ってほしいものを明示する
 * (ひな型を渡すだけでは作られない)。design モードでは設計書自体が対象なので出さない。
 */
export function missingDocNotes(docs: DocsResolution, mode: ProcedureMode): string[] {
  if (mode === "design") {
    // 設計中は仕様書の初版を「設計確定時」に作る。ただし既存機能の改修なら、
    // 設計書より先に改修対象の現状の仕様書(as-is)を起こしてもらう
    return docs.spec.length === 0
      ? [
          `仕様書(kind="spec")はまだありません。依頼が既存の画面・機能の改修なら、設計書より先に、改修対象の画面・機能に限った現状の仕様書(as-is)を ${docs.config.spec}/<画面名>.md として <template kind="spec"> の章立てで create してください(コードから読み取れる振る舞いのみ。不明は「未確認」)。新規の画面・機能なら設計確定時に初版を作ります。`,
        ]
      : [];
  }
  const notes: string[] = [];
  if (docs.spec.length === 0) {
    const name =
      docs.design.length === 1
        ? path.posix.basename(docs.design[0]!.relativePath)
        : "<設計書と同じファイル名>.md";
    notes.push(
      `仕様書(kind="spec")はまだありません。最初の回答で ${docs.config.spec}/${name} の初版を <template kind="spec"> の章立てで create してください(実装済みの振る舞いを反映。未実装の機能は「未」と記す)。`,
    );
  }
  if (docs.handoff === undefined) {
    notes.push(
      `引継ぎ書(kind="handoff")はまだありません。チャットを切り替えるときに ${docs.config.handoff} を create してください。`,
    );
  }
  return notes;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderDoc(entry: DocEntry, transform: (text: string) => string): string {
  const attrs = [`path="${escapeAttribute(entry.relativePath)}"`, `kind="${entry.kind}"`];
  if (entry.status !== undefined) {
    attrs.push(
      `status="${entry.status.status}"`,
      `blocking="${entry.status.blocking}"`,
      `deferred="${entry.status.deferred}"`,
    );
  }
  const body = transform(entry.content).replace(/\r?\n$/, "");
  return `<doc ${attrs.join(" ")}>\n${body}\n</doc>`;
}

/** パックに入れる文書(全文書)。design → spec → handoff の順 */
export function allDocs(docs: DocsResolution): DocEntry[] {
  return [...docs.design, ...docs.spec, ...(docs.handoff === undefined ? [] : [docs.handoff])];
}

/**
 * 本文用テキストに入れる文書。design モードは対象の設計書(新規なら空)、
 * それ以外は引継ぎ書(なければ空)。
 */
export function promptDocs(docs: DocsResolution, decision: ModeDecision): DocEntry[] {
  if (decision.mode === "design") {
    return decision.currentDesign === undefined ? [] : [decision.currentDesign];
  }
  return docs.handoff === undefined ? [] : [docs.handoff];
}

/** 本文用テキストに入れるひな型の種別。design モードは design + spec、他は handoff + spec */
export function promptTemplateKinds(mode: ProcedureMode): DocKind[] {
  return mode === "design" ? ["design", "spec"] : ["handoff", "spec"];
}

/**
 * <docs> ブロックの中身(閉じタグ込み)。entries が空なら注記だけを入れる。
 * @param transform 認証情報マスク等。パックと本文で同じ変換を通す
 */
export function renderDocsBlock(
  entries: readonly DocEntry[],
  transform: (text: string) => string = (t) => t,
  notes: readonly string[] = [],
): string {
  const header = [
    "プロジェクトの文書(docs/)。kind: design = 設計書(開発の進め方)、spec = 仕様書(実装済みの振る舞いの正本)、handoff = 引継ぎ書(前のチャットからの申し送り)。",
    "文書の更新は changes.md で出す(パスは path 属性)。設計書の status / blocking / deferred は 1 行目の状態行から。",
    ...notes.map((n) => `- ${n}`),
  ];
  const body =
    entries.length === 0
      ? "(文書はまだありません)"
      : entries.map((e) => renderDoc(e, transform)).join("\n\n");
  return `<docs>\n${header.join("\n")}\n\n${body}\n</docs>\n`;
}

/** <templates> ブロック(閉じタグ込み) */
export function renderTemplatesBlock(
  docs: DocsResolution,
  kinds: readonly DocKind[],
): string {
  const parts = kinds.map((kind) => {
    const body = docs.templates[kind].content.replace(/\r?\n$/, "");
    return `<template kind="${kind}">\n${body}\n</template>`;
  });
  return `<templates>\n文書のひな型。新しく作るときはこの章立てに従う(該当しない章は「該当なし」と書いて残す)。\n\n${parts.join("\n\n")}\n</templates>\n`;
}

/** CLI の 1 行表示用 */
export function describeDocs(docs: DocsResolution): string {
  const designs = docs.design.map((d) => {
    const s = d.status;
    const state =
      s === undefined ? "状態行なし" : `${s.status}${s.blocking + s.deferred > 0 ? ` 必須 ${s.blocking} / 後回し ${s.deferred}` : ""}`;
    return `${path.posix.basename(d.relativePath)} [${state}]`;
  });
  const parts = [
    `設計書 ${docs.design.length} 件${designs.length > 0 ? `(${designs.join(", ")})` : ""}`,
    `仕様書 ${docs.spec.length} 件`,
    docs.handoff === undefined ? "引継ぎ書なし" : "引継ぎ書あり",
  ];
  const overridden = DOC_KINDS.filter((k) => docs.templates[k].source === "file");
  if (overridden.length > 0) {
    parts.push(`ひな型の上書き: ${overridden.join(", ")}`);
  }
  return parts.join(" / ");
}
