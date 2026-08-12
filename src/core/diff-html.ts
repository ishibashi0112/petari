/**
 * ブラウザ差分ビューの HTML 生成 (§4.3)。純粋な文字列生成のみ (I/O なし)。
 *
 * セキュリティ方針:
 * - 補間箇所は全て escapeHtml を通す。ファイル内容は非信頼入力 (AI 出力) として扱い、
 *   </textarea> や <script> の注入を無効化する
 * - JS は一切使わない (フォーム POST のみ)。外部リソース参照ゼロ・インライン CSS のみ。
 *   未変更範囲の折りたたみも <details> (JS 不要) で行う
 * - textarea の値はエスケープ以外の加工禁止。制御文字を除去すると無編集行が
 *   「変更」扱いになり、保存時にユーザーが触っていない行の文字が消えるため。
 *   読み取り専用の diff ペインのみ表示用に双方向制御文字等を除去する
 * - フォームの action とリンクは相対パスのみ (URL のトークンを HTML 本文に埋めない)
 */
import { intralineRanges, type CharRange, type DiffRow } from "./diff.ts";
import type { Operation } from "../types.ts";

/** 1 ファイルの diff 表示上限行数 (巨大ファイルでのメモリ・描画保護) */
export const MAX_SECTION_ROWS = 20_000;

/** 変更行の前後に見せる未変更行数と、折りたたみを発動する最小行数 */
const FOLD_CONTEXT = 3;
const FOLD_MIN = 10;

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 表示専用の無害化 (term.ts と同じ集合: C0/C1 制御と Trojan Source 双方向制御)。
// textarea には適用しないこと (上記セキュリティ方針)
const DISPLAY_CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g",
);
function displayText(s: string): string {
  return escapeHtml(s.replace(DISPLAY_CONTROL_CHARS, ""));
}

/** 全ページ共通の CSP。サーバー応答ヘッダにも同じ値を使う (meta の form-action 等は
 *  無視されるブラウザがあるため、サーバー配信時はヘッダ側が正) */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const STYLE = `
:root{
  --bg:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--surface:#f6f8fa;
  --accent:#0969da;--ok:#1a7f37;--err:#d1242f;--rewrite:#8250df;
  --del-bg:#ffebe9;--del-hl:#ffb3ad;--ins-bg:#dafbe1;--ins-hl:#a5e8b7;
  --radius:8px;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--surface:#161b22;
  --accent:#4493f8;--ok:#3fb950;--err:#f85149;--rewrite:#ab7df8;
  --del-bg:#3b1a1d;--del-hl:#792e34;--ins-bg:#122b1d;--ins-hl:#1c5b34;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.wrap{max-width:1180px;margin:0 auto;padding:1.2rem 1.4rem 4rem}
header.page h1{font-size:1.25rem;margin:.2rem 0}
header.page .meta{color:var(--muted);font-size:.82rem;margin:.1rem 0 0}
nav.files{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:.4rem;
  padding:.6rem 0;margin:.4rem 0 .2rem;background:var(--bg);border-bottom:1px solid var(--border)}
nav.files a{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;text-decoration:none;
  color:var(--accent);background:var(--surface);border:1px solid var(--border);
  border-radius:2em;padding:.18em .7em}
nav.files a:hover{border-color:var(--accent)}
section.file{border:1px solid var(--border);border-radius:var(--radius);margin:1rem 0;
  overflow:hidden;background:var(--bg)}
.fhead{display:flex;align-items:center;gap:.6em;padding:.55rem .8rem;
  background:var(--surface);border-bottom:1px solid var(--border)}
.fhead code{font-size:.88rem;font-weight:600;word-break:break-all}
.op{font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  padding:.12em .6em;border-radius:2em;flex-shrink:0}
.op-replace{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.op-create{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}
.op-delete{color:var(--err);background:color-mix(in srgb,var(--err) 14%,transparent)}
.op-rewrite{color:var(--rewrite);background:color-mix(in srgb,var(--rewrite) 14%,transparent)}
.dlabels{display:grid;grid-template-columns:1fr 1fr;font-size:.74rem;color:var(--muted);
  background:var(--surface);border-bottom:1px solid var(--border)}
.dlabels div{padding:.28rem .7rem}
.dlabels div+div{border-left:1px solid var(--border)}
table.diff{border-collapse:collapse;width:100%;table-layout:fixed;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5}
col.cno{width:3.4em}
.diff td{vertical-align:top;padding:0 .55em}
.diff td.no{text-align:right;color:var(--muted);user-select:none;background:var(--surface);
  border-right:1px solid var(--border);padding:0 .5em}
.diff td.no.split{border-left:1px solid var(--border)}
.diff td.code{white-space:pre-wrap;word-break:break-all}
.diff td.code.del{background:var(--del-bg)}
.diff td.code.ins{background:var(--ins-bg)}
.code.del .hl{background:var(--del-hl);border-radius:2px}
.code.ins .hl{background:var(--ins-hl);border-radius:2px}
.diff td.code.empty{background:repeating-linear-gradient(45deg,var(--surface),
  var(--surface) 4px,var(--bg) 4px,var(--bg) 9px)}
details.fold summary{cursor:pointer;list-style:none;text-align:center;font-size:.76rem;
  color:var(--accent);background:var(--surface);padding:.28rem .6rem;
  border-top:1px solid var(--border);border-bottom:1px solid var(--border);user-select:none}
details.fold summary::-webkit-details-marker{display:none}
details.fold summary:hover{text-decoration:underline}
details.fold[open] summary{border-bottom-style:dashed}
p.note{color:var(--muted);font-size:.84rem;margin:.6rem .8rem}
.banner{border-radius:6px;padding:.55rem .9rem;margin:.7rem 0;font-size:.88rem;border:1px solid}
.banner.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent);
  background:color-mix(in srgb,var(--ok) 10%,transparent)}
.banner.err{color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,transparent);
  background:color-mix(in srgb,var(--err) 10%,transparent)}
section.editor{margin:1rem 0}
textarea{width:100%;min-height:24rem;padding:.8rem;resize:vertical;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;
  color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius)}
textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{font-size:.88rem;font-weight:600;padding:.45em 1.4em;border-radius:6px;cursor:pointer;
  border:1px solid transparent;background:var(--accent);color:#fff}
button:hover{filter:brightness(1.1)}
button.secondary{background:var(--surface);color:var(--muted);border-color:var(--border)}
.actions{display:flex;align-items:center;gap:.8rem;margin:.7rem 0}
.footer-actions{display:flex;align-items:center;gap:1rem;margin:1.6rem 0 0;
  padding-top:.9rem;border-top:1px solid var(--border)}
.footer-actions form{margin:0}
a.back{color:var(--accent);text-decoration:none;font-size:.88rem}
a.back:hover{text-decoration:underline}
ul.list{list-style:none;margin:.8rem 0;padding:0;border:1px solid var(--border);
  border-radius:var(--radius);overflow:hidden}
ul.list li{display:flex;align-items:center;gap:.7em;padding:.6rem .9rem;background:var(--bg)}
ul.list li+li{border-top:1px solid var(--border)}
ul.list a{color:var(--accent);text-decoration:none;font-family:ui-monospace,Menlo,monospace;
  font-size:.9rem;word-break:break-all}
ul.list a:hover{text-decoration:underline}
ul.list .note{color:var(--muted);font-size:.78rem;margin-left:auto;flex-shrink:0}
`.trim();

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
</body>
</html>
`;
}

function opBadge(op: Operation): string {
  return `<span class="op op-${op}">${op}</span>`;
}

/** 文字単位ハイライト付きでコードを描画する (範囲は元テキストのコードポイント index) */
function renderCode(text: string, ranges: CharRange[]): string {
  if (ranges.length === 0) return displayText(text);
  const chars = Array.from(text);
  const parts: string[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) parts.push(displayText(chars.slice(pos, r.start).join("")));
    parts.push(`<span class="hl">${displayText(chars.slice(r.start, r.end).join(""))}</span>`);
    pos = r.end;
  }
  if (pos < chars.length) parts.push(displayText(chars.slice(pos).join("")));
  return parts.join("");
}

const COLGROUP = `<colgroup><col class="cno"><col><col class="cno"><col></colgroup>`;

function renderRow(row: DiffRow): string {
  const intra =
    row.kind === "change" && row.left !== null && row.right !== null
      ? intralineRanges(row.left.text, row.right.text)
      : null;
  const cell = (
    side: { no: number; text: string } | null,
    cls: string,
    ranges: CharRange[],
    split: boolean,
  ): string => {
    const noCls = split ? "no split" : "no";
    return side === null
      ? `<td class="${noCls}"></td><td class="code empty"></td>`
      : `<td class="${noCls}">${side.no}</td><td class="code${cls}">${renderCode(side.text, ranges)}</td>`;
  };
  const delCls = row.kind === "del" || row.kind === "change" ? " del" : "";
  const insCls = row.kind === "ins" || row.kind === "change" ? " ins" : "";
  return `<tr>${cell(row.left, delCls, intra?.left ?? [], false)}${cell(row.right, insCls, intra?.right ?? [], true)}</tr>`;
}

/** 変更行の前後 FOLD_CONTEXT 行だけを見せ、長い未変更ランは折りたたみ対象にする */
function segmentRows(rows: DiffRow[]): Array<{ fold: boolean; rows: DiffRow[] }> {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind !== "same") {
      const from = Math.max(0, i - FOLD_CONTEXT);
      const to = Math.min(rows.length - 1, i + FOLD_CONTEXT);
      for (let j = from; j <= to; j++) keep[j] = true;
    }
  });
  const segs: Array<{ fold: boolean; rows: DiffRow[] }> = [];
  let i = 0;
  while (i < rows.length) {
    const k = keep[i] as boolean;
    let j = i;
    while (j < rows.length && keep[j] === k) j++;
    const chunk = rows.slice(i, j);
    segs.push({ fold: !k && chunk.length >= FOLD_MIN, rows: chunk });
    i = j;
  }
  return segs;
}

function renderDiffBlocks(rows: DiffRow[], leftLabel: string, rightLabel: string): string {
  const shown = rows.slice(0, MAX_SECTION_ROWS);
  const omitted = rows.length - shown.length;
  const parts: string[] = [
    `<div class="dlabels"><div>${escapeHtml(leftLabel)}</div><div>${escapeHtml(rightLabel)}</div></div>`,
  ];
  if (shown.every((r) => r.kind === "same") && shown.length > 0) {
    parts.push(`<p class="note">変更はありません (全 ${shown.length} 行一致)</p>`);
  }
  for (const seg of segmentRows(shown)) {
    const table = `<table class="diff">${COLGROUP}${seg.rows.map(renderRow).join("\n")}</table>`;
    if (seg.fold) {
      const from = seg.rows[0]?.left?.no ?? seg.rows[0]?.right?.no ?? 0;
      parts.push(
        `<details class="fold"><summary>未変更の ${seg.rows.length} 行を表示 (${from} 行目〜)</summary>${table}</details>`,
      );
    } else {
      parts.push(table);
    }
  }
  if (omitted > 0) parts.push(`<p class="note">以降 ${omitted} 行を省略しました</p>`);
  return parts.join("\n");
}

export interface ReportFileSection {
  path: string;
  op: Operation;
  body:
    | { kind: "rows"; rows: DiffRow[]; leftLabel: string; rightLabel: string }
    | { kind: "note"; note: string };
}

function renderFileSection(s: ReportFileSection, id: string | null): string {
  const inner =
    s.body.kind === "note"
      ? `<p class="note">${escapeHtml(s.body.note)}</p>`
      : renderDiffBlocks(s.body.rows, s.body.leftLabel, s.body.rightLabel);
  const anchor = id === null ? "" : ` id="${id}"`;
  return `<section class="file"${anchor}>
<div class="fhead">${opBadge(s.op)}<code>${escapeHtml(s.path)}</code></div>
${inner}
</section>`;
}

/** 静的差分レポート (全ファイルを 1 ページに)。閲覧専用・自己完結 */
export function buildReportPage(
  title: string,
  generatedAt: string,
  sections: ReportFileSection[],
): string {
  const nav =
    sections.length > 1
      ? `<nav class="files">${sections
          .map((s, i) => `<a href="#f${i}">${escapeHtml(s.path)}</a>`)
          .join("")}</nav>`
      : "";
  const body = sections.map((s, i) => renderFileSection(s, `f${i}`)).join("\n");
  return page(
    title,
    `<header class="page"><h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(generatedAt)} ・ ${sections.length} ファイル</p></header>
${nav}
${body}`,
  );
}

export interface IndexItem {
  path: string;
  op: Operation;
  /** null = 編集可。文字列 = 編集不可の理由 (リンクは張るが編集フォームは出ない) */
  note: string | null;
}

/** 編集サーバーのファイル一覧ページ */
export function buildIndexPage(title: string, items: IndexItem[], idleMinutes: number): string {
  const list = items
    .map((item, i) => {
      const note = item.note === null ? "" : `<span class="note">${escapeHtml(item.note)}</span>`;
      return `<li>${opBadge(item.op)}<a href="f/${i}">${escapeHtml(item.path)}</a>${note}</li>`;
    })
    .join("\n");
  const body = `<header class="page"><h1>${escapeHtml(title)}</h1>
<p class="meta">無操作 ${idleMinutes} 分でサーバーは自動終了します。編集途中の内容は保存されません。</p></header>
<ul class="list">
${list}
</ul>
<div class="footer-actions"><form method="post" action="quit"><button class="secondary">サーバーを終了</button></form></div>`;
  return page(title, body);
}

/** エラー・終了などの単文ページ (409 / 404 / 終了しました 等) */
export function buildMessagePage(title: string, message: string, backHref: string | null): string {
  const back =
    backHref === null
      ? ""
      : `\n<div class="footer-actions"><a class="back" href="${escapeHtml(backHref)}">← 戻る</a></div>`;
  return page(
    title,
    `<header class="page"><h1>${escapeHtml(title)}</h1></header>\n<p>${escapeHtml(message)}</p>${back}`,
  );
}
