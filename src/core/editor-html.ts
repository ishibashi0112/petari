/**
 * Monaco Editor (VS Code のエディタ実装) によるブラウザ差分エディタページ (§4.3 --edit)。
 * 純粋な文字列生成のみ。
 *
 * セキュリティ方針 (2026-08-12 Monaco 採用で更新):
 * - スクリプトは「ビルド時に同梱した monaco-editor (script-src 'self')」と
 *   「このファイルに埋め込んだ自前ブートストラップ (nonce)」のみ。
 *   外部 CDN・外部リソースへの参照はゼロ (CSP が遮断する)
 * - 埋め込みデータ (JSON) は JSON.stringify 後に < を < へ置換し、
 *   </script> による脱出を封じる (type="application/json" の不活性ブロック)
 * - トークンを HTML に埋め込まない: monaco 資産のパスは実行時に location.pathname
 *   から組み立てる。フォーム action・リンクは相対のみ
 * - JS が無効でも動く: <noscript> 内の素のフォーム (textarea) で保存できる。
 *   textarea の値はエスケープ以外の加工禁止・開きタグ直後の改行必須 (diff-html.ts と同じ理由)
 *
 * 実装メモ: monaco.editor.createDiffEditor が VS Code と同じ差分 UI
 * (view zone による完全な行整列・右ペイン編集・シンタックスハイライト) を提供する。
 * モデルの改行は monaco が単一 EOL に正規化するが、保存は §8 の mergeEditedText が
 * 行テキスト単位で raw バイトを保全するため、無変更行の実バイトは壊れない。
 */
import { escapeHtml, CSP } from "./diff-html.ts";

/**
 * エディタページ用 CSP。同梱 monaco ('self') + 自前ブートストラップ (nonce) のみ許可。
 * font-src data: は monaco の codicon フォント (CSS 内 data: URI)、
 * worker-src は monaco のエディタ/差分計算ワーカー用。
 */
export function editorCsp(nonce: string): string {
  return CSP.replace(
    "default-src 'none'; style-src 'unsafe-inline'",
    `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline' 'self'; ` +
      "font-src data:; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'",
  );
}

export interface EditorPageData {
  path: string;
  /** 左ペインのラベル (例: 適用前 (before)) */
  leftLabel: string;
  /** 比較元スナップショットの全文。null = 比較なし (note を表示し空と比較) */
  snapshotText: string | null;
  /** snapshotText が null のときの理由 */
  snapshotNote: string | null;
  /** 現在のファイル全文 (textarea/monaco へ。エスケープ以外の加工禁止) */
  currentText: string;
  baseSha256: string;
  /** ステータスバー表示 (例: Shift_JIS / CRLF) */
  encodingLabel: string;
  eolLabel: string;
  saved: boolean;
  errorBanner: string | null;
  /** null = 編集可。文字列 = 編集不可の理由 (エディタを出さない) */
  blockReason: string | null;
  idleMinutes: number;
  /** CSP script nonce (サーバーが応答ごとに生成) */
  nonce: string;
}

const STYLE = `
:root{
  --bg:#ffffff;--panel:#f3f3f3;--border:#e5e5e5;--fg:#1f1f1f;--muted:#6e7681;
  --accent:#005fb8;--accent-fg:#ffffff;--status-bg:#005fb8;--status-fg:#ffffff;
  --ok:#1a7f37;--err:#c72e2e;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#1e1e1e;--panel:#252526;--border:#3c3c3c;--fg:#d4d4d4;--muted:#858585;
  --accent:#0e639c;--accent-fg:#ffffff;--status-bg:#007acc;--status-fg:#ffffff;
  --ok:#89d185;--err:#f48771;
}}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;font-size:13px}
.app{display:flex;flex-direction:column;height:100vh}
.titlebar{display:flex;align-items:center;gap:.8rem;background:var(--panel);
  border-bottom:1px solid var(--border);padding:0 .6rem 0 0;flex-shrink:0}
.tab{display:flex;align-items:center;gap:.45em;background:var(--bg);border-right:1px solid var(--border);
  padding:.45em .95em;font-size:12.5px}
.tab code{font-family:ui-monospace,Menlo,Consolas,monospace}
#dirty{color:var(--fg);visibility:hidden}
.tb-sp{flex:1}
#msg{font-size:12px;color:var(--muted)}
#msg.ok{color:var(--ok)} #msg.err{color:var(--err)}
.btn{font-size:12.5px;padding:.34em 1.1em;border-radius:3px;border:1px solid transparent;cursor:pointer;
  background:var(--accent);color:var(--accent-fg)}
.btn:hover{filter:brightness(1.15)}
.btn.ghost{background:transparent;color:var(--fg);border-color:var(--border);text-decoration:none;display:inline-block}
.inline{display:inline}
.banner{padding:.4rem .8rem;font-size:12.5px;border-bottom:1px solid var(--border)}
.banner.ok{color:var(--ok)} .banner.err{color:var(--err)}
#ed{flex:1;min-height:0}
.note{color:var(--muted);padding:.8rem}
noscript textarea{width:100%;height:60vh;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:12.5px;background:var(--bg);color:var(--fg);border:1px solid var(--border)}
noscript .nsform{padding:.8rem}
.statusbar{display:flex;align-items:center;gap:1.2em;background:var(--status-bg);color:var(--status-fg);
  font-size:12px;padding:.18em .9em;flex-shrink:0}
.statusbar .sp{flex:1}
`.trim();

/** 埋め込み JSON: </script> 脱出と行分離子を封じる */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

// 埋め込みブートストラップ JS。テンプレートリテラル内のため ` と ${ は使わない
const BOOT_JS = String.raw`
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("pd").textContent);
  var msgEl = document.getElementById("msg");
  function setMsg(text, cls) {
    msgEl.textContent = text;
    msgEl.className = cls || "";
  }
  if (data.blocked) return;
  var saveBtn = document.getElementById("savebtn");
  var dirtyEl = document.getElementById("dirty");
  var statEl = document.getElementById("diffstat");
  var caretEl = document.getElementById("caret");
  // monaco 資産のベース URL。トークンは HTML に埋めず実行時に URL から得る
  var tokenBase = "/" + window.location.pathname.split("/").filter(function (s) { return s !== ""; })[0];
  var baseSha = data.baseSha256;
  var saving = false, dirty = false;
  var modified = null;
  var msgTimer = null;

  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = tokenBase + "/vs/editor/editor.main.css";
  document.head.appendChild(css);
  // 読み込みが黙って止まった場合の見張り (依存欠落は AMD ではエラーにならないことがある)
  var watchdog = setTimeout(function () {
    setMsg("エディタの読み込みに時間がかかっています (コンソールを確認してください)", "err");
  }, 20000);
  // 日本語 NLS: monaco 0.5x では AMD モジュールではなく素のスクリプトが
  // globalThis._VSCODE_NLS_MESSAGES を設定する方式。editor.main より先に読み込む。
  // (旧 availableLanguages 設定で読むと define されないモジュールを待ってハングする)
  var nls = document.createElement("script");
  nls.src = tokenBase + "/vs/nls/lang/ja.js";
  nls.onload = loadLoader;
  nls.onerror = loadLoader; // NLS がなくても英語 UI で続行
  document.head.appendChild(nls);

  function loadLoader() {
    var s = document.createElement("script");
    s.src = tokenBase + "/vs/loader.js";
    s.onload = boot;
    s.onerror = function () { setMsg("エディタ資産を読み込めませんでした", "err"); };
    document.head.appendChild(s);
  }

  function boot() {
    window.require.config({ paths: { vs: tokenBase + "/vs" } });
    window.require(["vs/editor/editor.main"], init, function () {
      setMsg("エディタを初期化できませんでした", "err");
    });
  }

  function init() {
    var monaco = window.monaco;
    var dark = window.matchMedia("(prefers-color-scheme: dark)");
    var original = monaco.editor.createModel(
      data.snapshotText === null ? "" : data.snapshotText,
      undefined,
      monaco.Uri.file("/original/" + data.path)
    );
    var mod = monaco.editor.createModel(
      data.currentText,
      undefined,
      monaco.Uri.file("/modified/" + data.path)
    );
    modified = mod;
    var diffEditor = monaco.editor.createDiffEditor(document.getElementById("ed"), {
      automaticLayout: true,
      originalEditable: false,
      renderSideBySide: true,
      ignoreTrimWhitespace: false,
      theme: dark.matches ? "vs-dark" : "vs",
    });
    diffEditor.setModel({ original: original, modified: mod });
    if (dark.addEventListener) {
      dark.addEventListener("change", function (e) {
        monaco.editor.setTheme(e.matches ? "vs-dark" : "vs");
      });
    }
    mod.onDidChangeContent(function () {
      if (!dirty) { dirty = true; dirtyEl.style.visibility = "visible"; }
    });
    diffEditor.onDidUpdateDiff(function () {
      var changes = diffEditor.getLineChanges() || [];
      var add = 0, del = 0;
      for (var i = 0; i < changes.length; i++) {
        var c = changes[i];
        if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0) {
          add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
        }
        if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0) {
          del += c.originalEndLineNumber - c.originalStartLineNumber + 1;
        }
      }
      statEl.textContent = "+" + add + " −" + del;
    });
    var me = diffEditor.getModifiedEditor();
    me.onDidChangeCursorPosition(function (e) {
      caretEl.textContent = "行 " + e.position.lineNumber + "、列 " + e.position.column;
    });
    me.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave);
    saveBtn.hidden = false;
    saveBtn.addEventListener("click", doSave);
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        doSave();
      }
    });
    window.addEventListener("beforeunload", function (e) {
      if (dirty) e.preventDefault();
    });
    clearTimeout(watchdog);
    setMsg("", "");
    me.focus();
  }

  function doSave() {
    if (saving || modified === null) return;
    saving = true;
    setMsg("保存中…", "");
    var body = new URLSearchParams();
    body.set("baseSha256", baseSha);
    body.set("text", modified.getValue());
    body.set("ajax", "1");
    fetch(window.location.pathname, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, j: j }; });
    }).then(function (r) {
      saving = false;
      if (r.j.ok === true) {
        baseSha = r.j.baseSha256;
        dirty = false;
        dirtyEl.style.visibility = "hidden";
        setMsg("保存しました ✓", "ok");
        if (msgTimer !== null) clearTimeout(msgTimer);
        msgTimer = setTimeout(function () { setMsg("", ""); }, 3000);
      } else {
        setMsg(r.j.error || "保存に失敗しました (" + r.status + ")", "err");
      }
    }).catch(function () {
      saving = false;
      setMsg("保存に失敗しました (接続エラー)", "err");
    });
  }
})();
`;

export function buildEditorPage(d: EditorPageData): string {
  const banners: string[] = [];
  if (d.saved) banners.push(`<div class="banner ok">保存しました</div>`);
  if (d.errorBanner !== null) banners.push(`<div class="banner err">${escapeHtml(d.errorBanner)}</div>`);
  if (d.blockReason !== null) banners.push(`<div class="banner err">${escapeHtml(d.blockReason)}</div>`);
  if (d.snapshotNote !== null) banners.push(`<div class="banner">${escapeHtml(d.snapshotNote)}</div>`);

  // JS 無効時のフォールバック: 素のフォーム POST (§8 の保存経路は同じ)。
  // <textarea> 開きタグ直後の改行はブラウザに 1 個食われるため必ず入れる
  const noscriptForm =
    d.blockReason !== null
      ? ""
      : `<noscript><div class="nsform">
<p class="note">JS が無効のため Monaco エディタは使えません。以下で直接編集して保存できます (${escapeHtml(d.leftLabel)}との差分表示はありません)</p>
<form method="post" action="">
<input type="hidden" name="baseSha256" value="${escapeHtml(d.baseSha256)}">
<textarea name="text" spellcheck="false" autocomplete="off">
${escapeHtml(d.currentText)}</textarea>
<p><button class="btn">保存</button></p>
</form>
</div></noscript>`;

  const editorArea =
    d.blockReason !== null
      ? `<div class="note">${escapeHtml(d.blockReason)}</div>`
      : `<div id="ed"></div>\n${noscriptForm}`;

  const data = {
    blocked: d.blockReason !== null,
    path: d.path,
    snapshotText: d.snapshotText,
    currentText: d.currentText,
    baseSha256: d.baseSha256,
  };

  const body = `<div class="app">
<div class="titlebar">
<div class="tab"><span id="dirty">●</span><code>${escapeHtml(d.path)}</code></div>
<span id="msg">エディタを読み込み中…</span>
<div class="tb-sp"></div>
${d.blockReason === null ? `<button class="btn" id="savebtn" hidden>保存</button>` : ""}
<a class="btn ghost" href="../">一覧</a>
<form class="inline" method="post" action="../quit"><button class="btn ghost">終了</button></form>
</div>
${banners.join("\n")}
${editorArea}
<div class="statusbar">
<span>${escapeHtml(d.leftLabel)} ⇔ 現在のファイル</span>
<span id="diffstat"></span>
<span class="sp"></span>
<span>無操作 ${d.idleMinutes} 分で自動終了</span>
<span>${escapeHtml(d.encodingLabel)}</span>
<span>${escapeHtml(d.eolLabel)}</span>
<span id="caret"></span>
</div>
</div>
<script type="application/json" id="pd">${embedJson(data)}</script>
<script nonce="${escapeHtml(d.nonce)}">${BOOT_JS}</script>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${editorCsp(d.nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.path)} — petari</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
