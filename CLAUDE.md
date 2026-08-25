# petari — 開発ガイド

チャットベース AI の返答 (changes.md) をローカルのコードベースへ安全に適用する CLI。
仕様の正本は [requirements.md](requirements.md)。本ファイルは実装時に決定した方針・規約を記録する。

## コマンド

- `pnpm typecheck` — tsc --noEmit
- `pnpm test` — vitest run
- `pnpm dev -- <args>` — CLI を直接実行 (Node 24 のネイティブ TS 実行)
- `pnpm build` — dist/ へ tsc ビルド + monaco 同梱 (vendor/)
- `pnpm gen:monaco` — monaco-editor を vendor/monaco へ同梱 (clone 直後に 1 回必要)

各実装ステップの完了条件: typecheck と test が全パスすること。

## 確定した設計方針

### 実行時依存はゼロ (サプライチェーン対策・ユーザー承認済み)

- CLI 引数解析: `node:util` の `parseArgs` + 自前ディスパッチ。commander 不使用
- Shift_JIS デコード: Node 組み込み `TextDecoder("shift_jis")` (full-ICU 前提。起動時チェックで明確にエラー)
- Shift_JIS エンコード: **ビルド時に TextDecoder 自身から逆引きテーブルを生成しコミット** (scripts/ に生成スクリプト)。iconv-lite 不使用。変換不能文字 = 逆引きテーブル欠落として検証エラー (§8)
- クリップボード: OS コマンド呼び出し (macOS: pbpaste/pbcopy, Windows: PowerShell Get-/Set-Clipboard)
- Windows Downloads: `reg query` で Known Folder GUID `{374DE290-123F-4565-9164-39C4925E467B}` を取得 (OneDrive リダイレクト対応)
- 出力の色付け: ANSI 直書きの小ユーティリティ
- 開発依存も最小: typescript / vitest / @types/node / monaco-editor (固定バージョン) のみ。
  tsx 不使用 (Node 24 ネイティブ TS 実行)
- **monaco-editor はビルド時同梱** (2026-08-12 ユーザー承認): `pnpm gen:monaco` が
  min/vs を `vendor/monaco/` へ丸ごとコピー (ハッシュ付きチャンクが相互参照するため
  部分コピー不可)。vendor/ は gitignore・`files` で npm パッケージに含める。
  `pnpm build` に同梱ステップを含む。clone 直後は `pnpm gen:monaco` の実行が必要
  (未実行だと `show --edit` のブラウザ経路が 1 行エラーで案内する)
- pnpm-workspace.yaml の `minimumReleaseAge: 10080` (7日) で新規公開バージョンを遅延取得

### レイヤ構成

- `src/core/` — **純粋ロジックのみ。ファイル I/O 禁止** (文字列/Buffer in → 結果 out)。parser / matcher / encoding / report / diff / diff-html / edit。テスト最厚領域 (§6, §8)
- `src/infra/` — I/O 層。history / config / root / downloads / clipboard / git / browser / diff-server
- `src/commands/` — コマンド層。薄く保ち、core と infra の結線のみ
- `src/assets/protocol.md` — 規約文の同梱原本 (single source)

### エンコーディング保全 (§8) の実装方式

- ファイルは **行単位ドキュメント** (`FileDocument`) として扱う。各行に元バイト列 (`raw`) と
  実際の改行コードを保持し、**変更していない行は raw をそのまま書き戻す**。
  再エンコードは変更行のみ。Shift_JIS の重複マッピング (NEC 選定 IBM 拡張 0xED- と
  IBM 拡張 0xFA- 等) があっても無変更行のバイト列は原理的に変わらない
- 検出順: UTF-16 BOM → 非対応エラー / UTF-8 BOM / 厳密 UTF-8 / Shift_JIS / エラー
- エンコード時の重複解決は Windows 慣習に合わせ NEC 選定 IBM 拡張 (0xED-0xEF) を回避
  (WHATWG エンコーダのポインタ除外 8272-8835 と同じ)。¥(U+00A5)→0x5C、‾(U+203E)→0x7E
- 既知の限界 (許容済み): ASCII のみの Shift_JIS ファイルは UTF-8 判定になる
  (新規追加した日本語が UTF-8 で書かれる)。半角カナのみの Shift_JIS が UTF-8 として
  有効なバイト列になる稀ケースも UTF-8 優先
- `src/core/sjis-table.ts` は自動生成 (`pnpm gen:sjis`)。手編集禁止

### TypeScript 規約

- ESM / NodeNext。相対 import は **`.ts` 拡張子付き** (`rewriteRelativeImportExtensions` で emit 時に .js へ書き換え)
- strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`
- テストは `tests/**/*.test.ts`。バイナリ前提のフィクスチャ (Shift_JIS 等) は `tests/fixtures/`

### §13 未確定事項の決定 (ユーザー承認済み)

1. `init` は独立コマンド。apply 時は `.petari/` 不在なら 1 行案内のみ (処理は止めない)
2. `--clip-report` は実装する
3. `historyLimit` の既定は `null` (無制限)。`petari list` に合計サイズを表示
4. `show --changes` で保存済み changes.md の CHANGES セクションを表示 (ステップ 5 で最小実装)

## 実装ステップ (§14 準拠) — 全ステップ完了 (2026-08-08)

0. 足場 → 1. パーサ (§3) → 2. マッチング (§6) → 3. エンコーディング保全 (§8) →
4. apply 本体 + history + 失敗レポート → 5. undo/show/list → 6. protocol → 7. Downloads/クリップボード → 8. init/config

実装中に確定した細部:

- パーサ: `## CHANGES` より前の行は無視 (チャットの前置き混入対策)。同一パスの FILE セクション重複はエラー。
  マーカー行の行末空白は許容。開いたブロック内では FILE 行もマーカー以外はすべて本文 (verbatim)
- 寛容パース (§3.5, 2026-08-22 実運用の規約違反対策):
  strict 失敗時のみ `parseChangesRecovering` が lenient 再パースし、**issues ゼロの場合に限り採用**
  (1 件でも残れば strict のエラーへフォールバック = 曖昧解釈で適用に進まない)。
  許容: マーカー記号 5〜16 個・スペース欠落 / 見出しレベルずれ / ブロック外のフェンス行。
  **ブロック本文 (SEARCH/REPLACE/CONTENT) は一切加工しない** (Markdown ファイル対象でも安全)。
  補正内容は適用前に全件表示。FILE 行の操作種別欠落は推定せずエラーのまま。
  あわせて buildParseErrorReport に「規約フォーマットの要点 (再掲)」を同梱
  (チャット側で規約文が要約落ちしていてもレポート単体で再出力依頼できる)。
  規約文 v3: 「出力前の自己チェック」節を追加 (PROTOCOL_VERSION=3、利用者は init 再実行)
- 失敗レポートの自動コピー (2026-08-22 ユーザー承認): config `clipReportOnFailure` 既定 true。
  emitReport 経由の全失敗レポートが対象 (--clip-report は設定によらず常に有効)。
  テストは実行機のクリップボードを汚さないよう各フィクスチャの config で false を明示
- 失敗レポートの診断拡充 (§7, 2026-08-25 実運用事例起点 — M365 Copilot が失敗原因を
  空白/Shift_JIS のバイト差と誤診し、SEARCH の空白調整・純 ASCII 化に 4 往復を浪費して
  未解決のままチャット移行に至ったログを解析して追加):
  ①照合仕様の明記 (空白・エンコ差は吸収済み = 失敗は文字内容の差) ②全ブロック成否一覧
  (別ファイルでは同じ SEARCH が通る、という対比が切り分けの鍵だった) ③all-or-nothing の
  未書き込みをレポート本文にも明記 (端末表示はチャットに貼られない) ④block-not-found に
  実ファイル近傍抜粋 (core/nearest.ts。スコア: trim 一致 3 > 空白圧縮 2 > 不可視文字畳み込み 1。
  抜粋行は AI がそのままコピーする前提で verbatim 厳守・説明は note に分離。全角スペース・
  波ダッシュ/全角チルダ等はコードポイント注記) ⑤ambiguous にマッチ位置の行番号。
  どの行も一致しない場合は「推測で書き換えず最新コードの共有を依頼」と AI に指示する
  (スナップショット陳腐化・チャット添付の要約チャンク欠落への出口)
- 空行欠落の診断 (2026-08-25 実運用フィードバック起点 — スナップショット (repomix 等) の
  変換で空行が落ち、SEARCH に空行 1 本が不足しただけで 2 連続失敗。旧診断文言
  「空白の問題ではない」が誤誘導になった):
  ①nearest.ts を固定幅ウィンドウのスライド照合からギャップ許容アラインメント
  (fit alignment: SEARCH 全行を消費、実ファイル側の開始位置は自由。スコア: trim 一致 6 >
  空白圧縮 4 > 不可視文字畳み込み 2 > 置換 -2、gap -3。置換 > gap×2 で不一致行も「!」の
  まま同じ行に並べる。DP セル数上限 20M で SEARCH 側を切り詰め) へ変更 — 1 行の過不足で
  位置合わせ全体がずれ別の類似箇所 (End Sub 等) を抜粋する問題の根治
  ②実ファイル側にだけある行は「+」印で抜粋に含め、空行なら専用注記。SEARCH 側の余分な
  空行は unmatchedSearch として報告 (空行は lineHits 対象外のためここが唯一の出口)
  ③near-miss 自動サジェスト: SEARCH 全行が順序どおり存在し differ ゼロなら「+ の行も含めて
  抜粋をコピーすれば一致」と機械的に提示 (全部空行なら空行欠落を名指し)
  ④照合仕様の文言を修正: 「空行は内容のある 1 行として数える」を明記し、「行の文字内容
  そのものが異なる」を「文字内容か行の構成 (空行を含む行の過不足)」へ
  ⑤検証結果一覧の末尾に「残る N ブロックの修正で全体が適用可能」の構造化サマリ
  ⑥SEARCH が全滅 (window null) のときは REPLACE 側でも近傍推定 (matchCount>=1 のみ採用)
  し「REPLACE 側の内容に近い実ファイル領域」として提示 (適用済み・スナップショット陳腐化の
  切り分け材料)。抜粋の前後コンテキストは 2 行 → 4 行へ拡大。
  発生源の調査結果: slnmix はファイル内容を verbatim 埋め込みで空行を落とさない
  (修正不要)。本家 repomix は output.removeEmptyLines: true 設定で空行が落ちるため、
  利用者へ repomix 設定の確認を案内する (petari init が生成する repomix.config.json は
  対象外だが、既存設定の持ち込みに注意)
- マッチング: 段階ごとに一意性判定 (exact で 1 件なら trim 段階の曖昧さは不問)。
  trim-all の再インデントは「非空行の最長共通空白プレフィックス」を基準に置換 (相対インデント維持)
- 適用済み検出・冪等性 (§6.1, v0.3.0 / 2026-08-11 実運用フィードバック起点):
  SEARCH 不一致時に REPLACE ブロック全体の存在を追加チェックし、あれば「済み」として成功扱い。
  比較は既存 3 段 + ws-collapse (行内連続空白の圧縮。スキップ判定専用で SEARCH マッチには不使用)。
  空・空行のみの REPLACE は判定対象外。rewrite/create は全文一致、delete は対象なしで「済み」。
  failed が 1 件でもあれば書かない all-or-nothing は維持。全件済みなら履歴を作らず exit 0。
  真の不一致には「基準スナップショットずれの可能性」ヒントを付す。
  既知の限界: REPLACE ⊇ SEARCH の追記型ブロックは再実行時に重複適用になり得る
- 引数なし実行の自動検出は Downloads + プロジェクトルート直下の changes*.md (直近 30 分・最新優先)。
  自動検出由来は適用成功後に削除 (原本は履歴に保存済み)。全件済みで履歴を作らなかった場合は残す
- 履歴: before 保存 → 書き換え → after+manifest の 2 段階 (`beginHistory`/`finishHistory`)。
  manifest に `applied` フラグ (undo が --partial 適用を正しく巻き戻すため)
- undo も all-or-nothing (before 欠損を全件検証してから書き込み)
- Downloads 由来の適用成功後は元ファイルを削除 (原本は history に保存済み)
- 失敗レポートは SEARCH と REPLACE の両方を引用 (単体で AI に貼り返せるように)

### セキュリティ設計 (2026-08-08 レビューで確定)

- 信頼境界: changes.md (AI/クリップボード由来) と、リポジトリ同梱され得る
  `.petari/` (config.json / manifest.json) は**非信頼入力**として扱う
- パス検証 (`invalidPathReason`) は apply だけでなく **undo / show でも manifest のパスに適用**する
- 書き込み系は `isInsideRoot` (最も近い実在祖先ディレクトリの realpath がルート配下か) で
  **symlink ディレクトリ経由のルート外書き込みを拒否**。undo は対象が symlink 化されていても拒否
- パス規則: 絶対パス・UNC・ドライブレター・`..`・`~`・`:` (ADS)・Windows 予約デバイス名を拒否
- `vscodeCommand` はコマンド名か絶対パスのみ (相対パス拒否 — リポジトリ内スクリプトの実行防止)
- 端末出力は `src/infra/term.ts` の `out`/`err` を必ず使う (C0/C1 制御文字を除去。
  ANSI エスケープ注入対策)。`process.stdout.write` 直書きは protocol (信頼済み同梱テキスト) のみ可。
  強調表示は同ファイルの `outEmphasis` (本文サニタイズ後に term.ts 内のリテラル定数の
  装飾コードだけを付与。非 TTY / NO_COLOR では装飾なし) — 注入対策は保たれる
- 子プロセスは常に execFile/spawn の配列引数 (シェル非経由)。PowerShell へ渡すパスは
  単一引用符 + `''` エスケープ
- 再監査 (2 回目) での追加: vscodeCommand の UNC 拒否 / 予約名判定は末尾ドット・空白を
  除去してから照合 / サニタイズに双方向制御文字 (Trojan Source) を追加 /
  config 値の実行時検証 (`validateConfig`)
- 許容済みの残リスク: 検証と書き込みの間の TOCTOU (単独利用 CLI のため)、
  vscodeCommand の絶対パス指定 (正規ユースのため許可。攻撃には事前のローカル侵害が必要)

### ブラウザ差分ビューのセキュリティ設計 (2026-08-12, show フォールバック + --edit)

- 編集サーバー (infra/diff-server.ts) は 127.0.0.1 + OS 割当ポートのみで待ち受け。
  URL パス先頭の 128bit 乱数トークンを**長さ検査 → timingSafeEqual** で照合
  (timingSafeEqual は長さ不一致で throw するため順序が重要。不一致は 404 で統一)。
  Host ヘッダ完全一致 (DNS rebinding 対策)、POST は Origin 存在時に自 origin 要求。
  ルートは固定 4 本で、クライアントからパスは受け取らない (整数インデックスのみ)
- 全応答に CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'self';
  frame-ancestors 'none'; base-uri 'none'` + nosniff / no-referrer / no-store。
  フォーム action とリンクは相対のみ (トークンを HTML 本文に埋めない)。
  ボディ上限 16 MiB / urlencoded のみ
- JS の扱い (2026-08-12 ユーザー要望で「JS ゼロ」から段階的に緩和 → 最終形は Monaco 採用):
  閲覧レポート・一覧・メッセージページは JS ゼロのまま。**編集エディタページのみ**
  `script-src 'self' 'nonce-<応答ごと乱数>'` — 'self' は同梱 Monaco 資産、nonce は
  core/editor-html.ts 埋め込みの自前ブートストラップ。外部 CDN・外部リソースは CSP で遮断。
  style-src 'self' 追加 (editor.main.css)、font-src data: (codicon)、worker-src 'self' blob:。
  埋め込み JSON データは `<` エスケープで `</script>` 脱出を封止。
  保存は fetch (`ajax=1` → JSON 応答) とフォーム POST (noscript) の両対応で JS 無効でも動く
- **Monaco 更新時の注意 (0.56 で実際にハマった点)**: 日本語 NLS は旧
  `"vs/nls": { availableLanguages }` 設定を使うと `nls/lang/ja.js` (AMD ではなく
  グローバル `_VSCODE_NLS_MESSAGES` を設定する素のスクリプト) の define を
  **エラーなしで永遠に待ってハング**する。editor.main より先に素の `<script>` で
  ja.js を読み込む方式が正 (editor-html.ts の BOOT_JS)。読み込み停止の検知用に
  20 秒のウォッチドッグあり
- Monaco 資産の配信は**起動時に vendor/monaco を列挙した許可リストへの完全一致のみ**
  (".." を含むキーはリストに現れないためトラバーサルは構造的に不成立)。
  資産にもトークン必須。エディタは monaco.editor.createDiffEditor (view zone の完全整列・
  シンタックスハイライト込み)。モデルは EOL を正規化するが保存は行テキスト単位の
  mergeEditedText なので無変更行の raw バイトは保全される (§8)
- **textarea の値は escapeHtml のみで他の加工禁止**: 制御文字除去をかけると無編集行が
  「変更」扱いになり保存時に文字が消える。開きタグ直後に \n を必ず挿入 (ブラウザが
  1 個食うため先頭改行が失われる)。lone CR / NUL を含む行があるファイルは
  ブラウザ編集不可 (HTML パーサが CR→LF 正規化・NUL→U+FFFD 置換で破壊するため閲覧のみ)
- 保存は invalidPathReason + isInsideRoot (起動時と保存直前の両方) + symlink 拒否 +
  sha256 楽観ロック (競合 409、ファイル無傷)。変換不能文字はユーザー入力を保持したまま
  バナー再表示。マージは core/edit.ts の mergeEditedText (行 diff で整列し無変更行の
  raw バイト・改行を維持 = §8。diff 品質はマージの正しさに影響しない設計)
- VS Code 不在判定は ENOENT に加え **EINVAL** (CVE-2024-27980 対応後の Node は
  .cmd/.bat をシェル非経由で spawn できない)。それ以外の起動失敗は従来通り exit 1
- 静的レポートの一時 HTML (tmpdir の petari-report-*) はコード平文を含むため、
  次回 show 実行時に 1 時間より古いものを自動削除 (閲覧中かもしれない直近分は残す。
  対象は接頭辞一致のディレクトリのみ、symlink は Dirent 判定で除外)
- 許容済み残リスク: 保存時 TOCTOU (既存方針と同じ) / 無操作タイムアウトによる
  編集ロスト (textarea 入力はリクエストを発生させないため既定 30 分 + 全ページに明記で
  緩和。自動リロードは編集内容を消すため禁止) / infra/browser.ts
  (open / xdg-open / Start-Process) は自動テストなし (clipboard.ts と同じく実機確認)

## メモ

- npm へ publish 済み (v0.1.0: 2026-08-08 / v0.2.0: 2026-08-11 規約文 v2 / v0.3.0: 2026-08-11 冪等性対応 /
  v0.4.0: 2026-08-12 ブラウザ差分ビュー — Monaco 同梱で tarball 5.7MB に増加 /
  v0.4.1: 2026-08-12 一時レポートの自動掃除)。リポジトリ: https://github.com/ishibashi0112/petari
  リリース手順: version を上げて `pnpm typecheck && pnpm test && pnpm build && pnpm publish` (認証はユーザー)
- 大きい変更の後は fallow (`npx -y fallow security` / `npx -y fallow`) で確認を取る運用
  (2026-08-08 初回実行: 実害指摘ゼロ。clipboard.ts の spawn 指摘は誤検知と検証済み。
  2026-08-12 ブラウザ差分ビュー追加後: diff-server.ts の writeHead 指摘 (CWE-113) は
  ヘッダ値がリテラル定数・自前生成乱数 (hex/base64 で CR/LF を含み得ない)・検証済み整数
  のみのため誤検知と検証済み。JS 解禁後の再実行でも同族のみ。
  2026-08-25 失敗レポート診断拡充後の再実行: 既知の誤検知 2 族 (clipboard spawn /
  diff-server writeHead) のみで、新規コード (nearest/report/applier) への指摘なし。
  同日の空行診断 (アラインメント化) + init の removeEmptyLines 検知追加後の再実行も同結果)
- クリップボード実装 (pbcopy/pbpaste, PowerShell) とブラウザ起動 (infra/browser.ts) は
  自動テストなし (実機確認のみ)。Windows 実機での Get-Clipboard / reg query /
  Known Folder / Start-Process の動作確認が未了
- slnmix 連携は slnmix v0.7.0 (2026-08-08) で対応済み: 入力と同じディレクトリの
  protocol.md を `<instruction>` タグで囲んで出力末尾に自動連結する。このため
  **規約文に `<instruction>` という文字列を含めない** (protocol.ts の docstring にも明記)。
  規約文の変更時は PROTOCOL_VERSION を上げ、利用者には `petari init` 再実行で追従してもらう
- 埋め込み規約文だけでは AI チャットに無視されることがある (実運用で確認、2026-08-10)。
  チャットサービスが長文貼り付けを要約・検索で処理すると末尾の規約文がモデルに
  届かないため、埋め込みで確実に認識させる方法はない。対策としてチャット本文に
  1 行添える運用を README 連携節に明記し、規約文 v2 で書き出しを自己宣言型
  (「ユーザー本人からの恒常的な指示」) に強化した
- Bun 移行は検討の上で不採用 (2026-08-08)。run-once CLI のため速度差は知覚不能、
  npm 配布 (Node 前提) と情シス審査向けの保守的構成を優先。テストが遅くなったら
  `bun test` のみの部分採用を再検討
