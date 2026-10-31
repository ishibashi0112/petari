# petari — 開発ガイド

チャットベース AI の返答 (changes.md) をローカルのコードベースへ安全に適用する CLI。
仕様の正本は [requirements.md](requirements.md)。本ファイルは実装時に決定した方針・規約を記録する。

## コマンド

- `pnpm typecheck` — tsc --noEmit
- `pnpm test` — vitest run
- `pnpm dev -- <args>` — CLI を直接実行 (Node 24 のネイティブ TS 実行)
- `pnpm build` — dist/ へ tsc ビルド

各実装ステップの完了条件: typecheck と test が全パスすること。

## 確定した設計方針

### 実行時依存はゼロ (サプライチェーン対策・ユーザー承認済み)

- CLI 引数解析: `node:util` の `parseArgs` + 自前ディスパッチ。commander 不使用
- Shift_JIS デコード: Node 組み込み `TextDecoder("shift_jis")` (full-ICU 前提。起動時チェックで明確にエラー)
- Shift_JIS エンコード: **ビルド時に TextDecoder 自身から逆引きテーブルを生成しコミット** (scripts/ に生成スクリプト)。iconv-lite 不使用。変換不能文字 = 逆引きテーブル欠落として検証エラー (§8)
- クリップボード: OS コマンド呼び出し (macOS: pbpaste/pbcopy, Windows: PowerShell Get-/Set-Clipboard)
- Windows Downloads: `reg query` で Known Folder GUID `{374DE290-123F-4565-9164-39C4925E467B}` を取得 (OneDrive リダイレクト対応)
- 出力の色付け: ANSI 直書きの小ユーティリティ
- 開発依存も最小: typescript / vitest / @types/node のみ。
  tsx 不使用 (Node 24 ネイティブ TS 実行)
- **同梱サードパーティなし**: 2026-08-12 に `show --edit` のブラウザ編集用として同梱した
  monaco-editor は v0.13.0 (2026-10-28 ユーザー承認) で削除。パッケージの 99%
  (展開後 24.8MB 中 24.5MB) を占め、slnmix の依存経由で `npx slnmix` にも載っていた。
  slnmix init が git リポジトリを前提にしたため差分確認は git で足りる。ブラウザ編集
  (127.0.0.1 の一時サーバー) も同時に廃止し、`show --edit` は VS Code 専用。
  他者のコードを同梱する機能は、導入審査の説明 (同梱物・待ち受け) が増えるため安易に戻さない
- pnpm-workspace.yaml の `minimumReleaseAge: 10080` (7日) で新規公開バージョンを遅延取得

### レイヤ構成

- `src/core/` — **純粋ロジックのみ。ファイル I/O 禁止** (文字列/Buffer in → 結果 out)。parser / matcher / encoding / report / diff / diff-html / vbproj / new-file-style / watch。テスト最厚領域 (§6, §8)
- `src/infra/` — I/O 層。history / config / root / downloads / clipboard / git / browser / vbproj (最寄り .vbproj 探索) / new-file-style (手本収集)
- `src/commands/` — コマンド層。薄く保ち、core と infra の結線のみ (apply の .vbproj 登録結線は vbproj-register.ts に分離)
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
  (修正不要。デコード decodeSourceBuffer・資格情報マスキングにも行操作なしを確認済み)。
  本家 repomix は output.removeEmptyLines: true 設定で空行が落ちるため init で検知するが、
  当該プロジェクトにはこの設定が無かった (2026-08-25 利用者確認)。よって真因は
  チャットサービス側 (M365 Copilot) の添付・長文処理での空行喪失が最有力 —
  「規約文が要約チャンク化で落ちる」既知問題 (2026-08-10) と同じ経路。発生源での防止は
  不可能なため、レポート側の + 印 + 修正ヒント (1 往復で自己解決) が防衛線になる。
  2026-08-30: 診断での 1 往復すら手間なため、4 段目 blank-insensitive で往復なしに
  吸収する方針へ (下記「マッチング」参照)。nearest の診断が空行差を報告するのは
  「空行以外にも差がある」ケースだけになったため、空行ヒントの文言を「空行の差は
  自動吸収されるため原因は他の行」に修正 (旧文言のままだと誤誘導になる)
- マッチング: 段階ごとに一意性判定 (exact で 1 件なら trim 段階の曖昧さは不問)。
  trim-all の再インデントは「非空行の最長共通空白プレフィックス」を基準に置換 (相対インデント維持)
- 空行差無視マッチ (blank-insensitive, 2026-08-30 上記の空行欠落事例の恒久対策):
  SEARCH マッチングを exact → trim-end → trim-all → blank-insensitive の 4 段構成に。
  4 段目は SEARCH と実ファイルの双方から空行 (trim で空) を除いた行列を trim-all 比較で
  連続一致探索し、一致数 1 のときのみ成功 (2 件以上は ambiguous、positions は元行番号)。
  マッチ範囲は最初と最後の非空行で囲まれた元ファイル範囲 (内部の空行は含む、外側の空行は
  含まない = SEARCH の先頭/末尾の空行は照合範囲外)。SEARCH が空行のみなら試行しない。
  REPLACE は trim-all と同じ reindent を適用し、REPLACE 側の空行はそのまま挿入する
  (勝手に削ると意図的な空行挿入まで潰れるため)。既存 3 段の挙動は不変 (段階順フォールバック)。
  blank-insensitive での適用が 1 件でもあれば dry-run / 適用サマリの末尾に注記 1 行
  (report.ts の buildBlankInsensitiveNote。git diff での空行並び確認を促す)。
  fuzzy マッチ (編集距離・類似度) 不採用の方針は維持 — 空行無視は決定論的で
  コードの意味を変えない差だけを許容する線引き。
  未対応 (意図的スコープ外): 適用済み判定 (findContentStage / contentEqualsStage) への
  空行無視比較の追加。blank-insensitive で適用された REPLACE は verbatim で挿入されるため
  再実行時は既存段階の存在チェックでほぼ拾える
- 適用済み検出・冪等性 (§6.1, v0.3.0 / 2026-08-11 実運用フィードバック起点):
  SEARCH 不一致時に REPLACE ブロック全体の存在を追加チェックし、あれば「済み」として成功扱い。
  比較は既存 3 段 + ws-collapse (行内連続空白の圧縮。スキップ判定専用で SEARCH マッチには不使用)。
  空・空行のみの REPLACE は判定対象外。rewrite/create は全文一致、delete は対象なしで「済み」。
  failed が 1 件でもあれば書かない all-or-nothing は維持。全件済みなら履歴を作らず exit 0。
  真の不一致には「基準スナップショットずれの可能性」ヒントを付す。
  (旧・既知の限界だった REPLACE ⊇ SEARCH の追記型ブロックの重複適用は v0.10.0 で対処 — 下記)
- 二重適用の防止 (v0.10.0 / 2026-09-29 実運用事例起点 — RDP 越しに changes.md を受け渡す
  運用で、適用済みの changes.md を取り違えてもう一度当て、追記型ブロックの Sub が重複して
  ビルドエラーになった):
  ①**追記型ブロックの適用済み判定** (matcher.ts の findInsertionPresenceStage):
  SEARCH が一意に一致しても、挿入しようとしている行が一致範囲を内側に含む形で既にあれば
  「済み」(AlreadyAppliedBlock.insertion)。一致範囲の外に内容のある行を足すものだけが対象
  (書き換え・空行追加のみは対象外)。比較は空行を除いた行列 × exact / trim-end のみ —
  インデント違いを同一視すると入れ子の End If 補完を外側の End If で「済み」と誤判定するため。
  候補は reindent 済み置換行と REPLACE 原文の両方 (前回 trim-all 補正で入った場合と
  原文のまま入った場合)。ambiguous 時の判定は入れない (失敗のままで安全側。R が別の場所に
  あるだけで「済み」にすると正当な修正を黙って落とし得る)
  ②**指紋による再適用防止** (core/fingerprint.ts + history.ts の findAppliedHistory):
  パース後の変更内容の SHA-256 を manifest の changesFingerprint に記録し、同じ指紋の
  未 undo 履歴があって**なお書き込みが発生する**ときだけ止める (exit 1、--force で解除、
  --dry-run は警告のみ)。全件済みで書き込みなしの再実行は従来どおり exit 0 (既存の冪等性
  テストの挙動を維持)。undo は manifest に undoneAt を追記して対象外にする。旧形式の
  manifest は保存済み changes.md を再パースして算出 (過去分にも効く)。指紋は前置き・概要・
  改行コード・寛容パースの補正に依存しない。ファイル名の `(1)` 等は自動検出の
  `changes*.md` がもともと許容している
- 引数なし実行の自動検出は Downloads + プロジェクトルート直下の changes*.md (直近 30 分・最新優先)。
  自動検出由来は適用成功後に削除 (原本は履歴に保存済み)。全件済みで履歴を作らなかった場合は残す
- 履歴: before 保存 → 書き換え → after+manifest の 2 段階 (`beginHistory`/`finishHistory`)。
  manifest に `applied` フラグ (undo が --partial 適用を正しく巻き戻すため)
- undo も all-or-nothing (before 欠損を全件検証してから書き込み)
- Downloads 由来の適用成功後は元ファイルを削除 (原本は history に保存済み)
- 失敗レポートは SEARCH と REPLACE の両方を引用 (単体で AI に貼り返せるように)
- `petari watch` (v0.12.0 / 2026-10-11、往復の手作業削減): 新着検出は core/watch.ts の
  純粋な状態機械 (開始時の一覧は対象外 / 同じ mtime・size を 2 回観測で確定 / 0 バイトは待つ /
  渡したものは印が変わるまで再度渡さない / 消えたら忘れる)。I/O は 1 秒間隔のポーリング
  (fs.watch はプラットフォーム差があり、ネットワークドライブ上の Downloads では通知が来ない
  ことがあるため不採用。ディレクトリ 2 つの readdir + stat なので負荷は無視できる)。適用は
  applyCommand の第 2 引数 `detected` (自動検出と同じ source 種別 = 成功後に履歴へ移動) に
  `--yes` で渡すだけで、検証・レポート・指紋の二重適用防止は apply と共通。`## CHANGES`
  見出しの無いファイル (直下の変更履歴 CHANGES.md 等) は当てない (hasChangesHeading)。
  `--partial` / `--force` は受け付けない (確認なしの部分適用・再適用をしない)。
  SIGINT は once で受けて現在の適用の完了後に抜ける (2 回目の Ctrl+C は即終了)

### 伏せ字 [MASKED] の扱い (2026-10-31, v0.14.0)

slnmix のマスク機能の確認 (2026-10-31) で、AI の SEARCH に `[MASKED]` が入ると必ず不一致になり、
失敗レポートの近傍抜粋 (AI に貼る前提で自動コピー) に**実際の値がそのまま出る**こと、
rewrite / REPLACE が `[MASKED]` をそのまま書いて実際の値を消すことを再現した (ユーザー承認の上で修正)。

- core/mask.ts の maskCredentials は slnmix の src/services/credentialMasker.ts の写し
  (タブ → 2 スペースと noUncheckedIndexedAccess 対応のみ)。判定を変えるときは両方を揃え、
  tests/mask-credentials.test.ts も slnmix のテストの写しとして保つ。統合 (slnmix 設計書 §25) で 1 つに戻す
- 伏せた表示は**行の数と位置を保つ**。行ごとに伏せる・全体の行数だけ揃える方式は、複数行にまたがる値
  (行継続の代入・複数行の属性値) の漏れと、秘密鍵の BEGIN / END 行の書き換え・行のずれを起こした
  (2026-10-31 の別視点レビューで再現)。そこで maskCredentials を**ファイル全体**にかけ、結果を [MASKED] で
  区切った各部分を元の文字列から順に探して「伏せた範囲」を元の位置で求め (maskedSpans。秘密鍵ブロックの
  「改行 + 伏せ字 + 改行」だけは伏せ字 1 つに戻してから)、行ごとに当てはめる。伏せ字のない行は元の行と
  必ず同じ。複数行にまたがる範囲は各行の該当部分を伏せ (行頭・行末の空白は残す)、その行は wrapped
- 伏せ方は slnmix が使い得るもの全部: .vb は VB として / 汎用テキストとして (generic 構成の追加
  ディレクトリ) × strict の有無。失敗レポートの抜粋 (maskLinesForDisplay。SEARCH / REPLACE の近傍とも) は
  全部の伏せ方の範囲を合わせて伏せる。範囲を対応づけられない伏せ方があれば空行以外をすべて伏せる (安全側)
- strict のエントロピー判定がトークンの一部だけを伏せると、伏せ方を合わせた表示で残りの部分が見える
  (2 回目のレビューで JWT / Bearer の残りの漏れを再現)。そこで部分的に伏せた JWT・Bearer トークンは
  残りも伏せる (PARTIAL_JWT / PARTIAL_BEARER。slnmix のパックでもトークン全体が 1 つの [MASKED] になる)。
  前の 2 つが伏せ字で残りが 20 文字未満の並び (`[MASKED].[MASKED].database.windows.net` のような高エントロピーの
  サブドメインを持つホスト名) は除く (isShortTail。7・8 回目のレビューで、ホスト名を伏せすぎるのと、「.」が続くかで
  判定すると URL の末尾の拡張子に続く JWT の署名が残るのを再現)。JWT の署名は 43 文字以上なので、伏せ損ねて残る
  署名は長い並びになる (20 文字未満の残りは実際の署名ではないため、見えても main と同じ)。文字列の連結 (`" & _` / `" +`)
  や伏せ字が続くときは署名が途中で切れているので伏せる (9 回目のレビュー)
- SEARCH に `[MASKED]` があり実ファイルで不一致のときだけ、伏せた表示 (maskedViews) で照合し直す
  (既存 4 段の挙動は不変)。表示は伏せ方ごとのものに加えて、抜粋と同じ合わせ方のもの (失敗レポートの抜粋を
  写した SEARCH 用。.vb では `pwd = [MASKED]` のように汎用テキストの伏せ方も混ざる)。実ファイルで一意に
  一致しても、伏せた表示で別の位置に一致・複数一致するなら ambiguous (実ファイルの `[MASKED]` という文字の行と、
  伏せると同じに見える実際の値の行を取り違えない)。
- 伏せた表示は**元のファイルにだけ**作り (ファイルごとに 1 回)、ブロックを適用したあとは各行が元のファイルの
  どの行と同じ内容か (provenance) で引き継ぐ。伏せるかどうかは前後の行に依存する (行継続の代入・`password:= _`
  など) ため、今の行配列から作り直すと、先のブロックが前の行を変えただけで次のブロックの抜粋に値が出た
  (3 回目のレビューで再現)。元の値に戻した行は戻す元の行、SEARCH の範囲の行を (インデント以外) そのまま
  残した行はその行を引き継ぎ、それ以外の書いた行は AI の書いた行そのもの (伏せ字なし) として扱う。
  作り直しがなくなったため、3 万行のファイルに伏せ字のブロックが 40 個あっても 3 秒程度で終わる。wrapped の行を含む一致は
  採らない (パックではその行が 1 行にまとめて見えるため、AI が写した行とは本来一致しない)。適用済み判定も
  REPLACE に伏せ字があれば同じ照合で行い、**一意のとき**、かつ REPLACE の伏せ字の行と同じ表示の行の値が
  ファイル内で 1 通りのときだけ「済み」にする (伏せると同じに見える別の値の箇所 (本番用と試験用の
  パスワードなど) を取り違えて、必要な変更を黙って飛ばさない)。空行の差だけを吸収した一致 (blank-insensitive)
  も「済み」にしない (伏せ字のない REPLACE の findContentStage と同じ)
- 複数行にまたがる値を伏せた行 (wrapped) を含む一致は採らないため、抜粋を写した SEARCH が同じ失敗を
  繰り返さないよう、失敗の理由でその行番号を名指しし、照合仕様の伏せ字の項にも「SEARCH に含めない」を書く。
  抜粋ではその行に専用の注記を付け、「+ の行も含めてコピー」の注記・修正のヒントは出さず、依頼にも例外を書く
  (6 回目のレビューで、ヒントどおりに写すと同じ失敗を繰り返すのを再現)。字下げした秘密鍵では END の行の字下げも
  伏せた範囲に入る (パックでは END の行が字下げなしで見える)。伏せ字のない SEARCH は実ファイルで照合するので、
  その行を含んでも一致する。そこで印は 2 種類 (WindowLine.wrapped。抜粋に伏せ字があるときだけ付ける):
  "always" = 伏せ字を含むその行 (含めると必ず一致しない)、"with-mask" = 伏せ字を含まないその行 (END の行など。
  [MASKED] を含む行と同じ SEARCH に入れたときだけ一致しない =「[MASKED] を含む行と一緒に使えない行」として
  注記し、伏せ字のない範囲の目印には使える。見分けにくい文字などの注記はそのまま残す)。照合仕様・依頼の説明も
  抜粋にある種類の分だけ載せる。修正のヒントは、SEARCH に対応づけた行に "always" があるか、"with-mask" と伏せ字の行が
  両方あるときだけ出さず、前後の文脈の行だけに印があるなら「記号の付いた行だけを写す」と明記して出す
  (7〜10 回目のレビューで、ヒントの落としすぎ・文脈の鍵の本文の行を写して同じ失敗を繰り返すこと・一意に特定するのに
  使える END の行まで名指しすること・逆に文脈の伏せ字の行と一緒に写すと一致しない END の行を名指ししないことを再現)
- 書き込む行の `[MASKED]` は restoreMaskedLines で元の値に戻す。戻すのは、伏せた表示の**同じ文字列の行**
  (前後の空白を除いて一致。replace は SEARCH の一致範囲、rewrite はファイル全体) があり、値が 1 通りに
  決まる行だけ。ただし、実際の値を伏せた行を元の範囲より多く書くなら、写して足した行があり別のキー・別の場所
  (`<value>[MASKED]</value>` のキーは前の行、INI のセクションや If の分岐の中の `pwd = [MASKED]`) に同じ値を書き得るため
  戻さない (reason "copied"。12 回目のレビューで My.Settings の設定を写して足した回答が元の値を新しい設定に入れるのを、
  13・14 回目でキーの判定 (その行だけで伏せられるか) では高エントロピーの値や INI のセクション・分岐を防げないのを再現し、
  行の種類によらず数で判定する方式にした。並べ替え・字下げ・まわりの行の編集・ファイル全体の書き直しでは数は増えない)。
  数えるのは表示ではなく戻した行ごと (伏せ方の違う 2 つの表示 (strict の有無など) から同じ行を 2 回書く回答を 15 回目の
  レビューで再現したため)。止める理由の一覧は同じ行・同じ理由を 1 つにまとめて数を添える。
  戻せない形の候補 (値を分けられない・複数行の値の一部) は、同じ行が別の伏せ方で戻せるなら候補から除く (汎用テキストの
  伏せ方だけが複数行の値とみなす行で、同じ行の候補が 2 つになって曖昧で止まったため。適用済み判定の valueSetsOf も同じ)。
  候補が戻せない形だけなら reason "unseparable" (その行を含まない範囲で変更するよう案内する)。伏せ字を含む行の書き換え・追加・コメントへの [MASKED] は戻さない (一時期あった「伏せ字の数が
  同じ行から位置で埋める」方式は、キーの入れ替えで値が入れ替わる・新しい行に別の秘密が入る・コメントに
  値を書き出すことをレビューで再現したため廃止)。create は戻す元がない。戻せなければ FailureKind
  "masked-value" で止める (all-or-nothing に乗る)。失敗の理由には戻せない行をすべて載せる (先頭 5 行 + 残りの数)。
  戻した数は restoredMasks に記録し buildMaskRestoreNote で注記
- 実ファイルにもともとある `[MASKED]` という文字は、範囲の対応づけで「値が [MASKED] の伏せ字」になるため、
  その行を残せばその文字のまま書く (数えない)。[MASKED] という文字を新しく書く変更は `--literal-masked`
  (PlanOptions.literalMasked) のときだけ書く。ただし変更する範囲 (replace は SEARCH の一致範囲、rewrite は
  ファイル全体) に実際の値を伏せた行があれば、指定があっても使わない (literalRefused。伏せ字の行を書き換えた
  回答で実際の値を [MASKED] の文字で上書きしたのを 2 回目のレビューで再現)。さらに、変更する既存ファイル
  (replace / rewrite / delete) と作るファイルの全体で、伏せていた実際の値のどれかが変更の後に数を減らすなら
  使わない (planChangeSet で指定なしに計画し直し、masked-value に literalRefused を付ける。ファイルの移動
  (delete + create) や行の移動で、実際の値が [MASKED] の文字に置き換わるのを 3 回目のレビューで再現)。
  数えるのは変更の前後それぞれを抜粋と同じ伏せ方で伏せた値 (maskedValueCounts。複数行にまたがる秘密鍵の
  本文なども行ごとに数える。4 回目のレビューで、行ごとの値だけを数えて秘密鍵の移動を見逃したのを再現)。
  比べるのはファイルごと (元の値に戻すのは同じファイルの行からだけなので、別のファイルで同じ値の行を
  増やしても埋め合わせにしない)。読めないファイル (UTF-16 など) があれば減るものとして扱う (5 回目のレビュー)。
  この計画で書いた行の [MASKED] は、伏せた表示では [MASKED] という文字そのもの (値が [MASKED] の伏せ字) として
  扱う (次のブロックがその行を残したときに空の値で埋めない)。この指定の案内は端末にだけ出し、
  AI に貼るレポートには書かない (実際の値を伏せた行にまで指定を勧めさせないため)。案内は指定すれば書ける
  とき (literalAllowed で、指定ありで計画し直しても masked-value が残らない) だけ、使わなかったときは
  その理由を出す。petari watch (applyCommand に detected を渡す経路) では案内しない。書いた数は literalMasks に記録して注記する。
  watch では受け付けない
- 伏せ字を含む行を書く変更のどれかが書かれないとき (masked-value の失敗・当てられない (block-not-found /
  target-missing / target-exists など)・適用済みと判定した。hasUnwrittenMaskedLine) は、伏せていた実際の値が
  ファイルの文字列から (数を) 減らす他の変更を書かない (FileOutcome.withheld + 専用の masked-value の失敗。
  --partial でも書かない。withholdMaskedLosses)。伏せ字の行を別のブロック・別のファイルへ移す回答で移動先が
  書かれないと、--partial (適用済みの判定では --partial なしでも) が移動元の削除だけを書いて値が作業ツリーから消え、
  同じ回答を出し直しても戻す元がもうない (16・17 回目のレビューで再現。App.config への移動は移動先の SEARCH を
  推測しがちで当たらないことが多い)。比べるのは伏せた値の文字列がファイルに現れる数 (伏せ方が変わっても値が残る
  変更は止めない。値の端が英数字なら語の途中に現れたものは数えない)。値が非常に多い大きなファイルは伏せた値の数で
  比べ、読めないファイル (UTF-16) は消すものとして扱う (安全側)。no-source の理由には (create 以外で)
  「同じファイルの中で移すなら元と新しい位置を 1 つのブロックに」を添える
- tests/mask.test.ts にレビューで再現した各ケース (値の取り違え 4 種・秘密鍵の行の破壊・行のずれ・行継続の
  漏れ・generic の .vb・同じに見える別の値の「済み」) を回帰テストとして置く。2026-10-31 には
  ランダムに組んだファイルで、伏せた表示の行の復元・抜粋の漏れ・値の作り出し・[MASKED] の書き込みが
  起きないことも確かめた (各 2〜6 万回。--literal-masked のときに実際の値を上書きしない・値が消えないことも)
- 失敗レポートの照合仕様の節に「[MASKED] を含む行は一字も変えずに写す・書き換えや追加はできない」を、レポートに
  [MASKED] が出るときだけ載せる (規約文は変えない。
  slnmix の手順文 (初版から) に「[MASKED] はそのまま残し、値を推測しない」が既にある)

### slnmix 設計書 §11 の実装 (2026-09-12, v0.9.0)

設計正本は slnmix リポジトリの `docs/HANDOFF-slnmix-petari-2026-09.md` §11 (petari の改修)。
決定事項は同書 §17 決定ログに追記済み。実装した範囲: §11.1 (P1-a) / §11.2 (P1-b) / §11.4。
§11.3 (P2 目録警告) は slnmix フェーズ 4 (`--manifest`) 後の任意項目のため未着手。

- **P1-a: create した .vb の旧スタイル .vbproj 自動登録** (core/vbproj.ts + infra/vbproj.ts +
  commands/vbproj-register.ts)。XML パーサは入れず行単位の正規表現処理。純粋関数は
  「行配列 in → 挿入位置 + 挿入行 out」(設計書のテキスト in/out から変更: 挿入行だけを
  DocLine (raw: null) として差し込めば §8 の行単位保全がそのまま効くため)。
  判定順: SDK スタイル → 登録済み (区切り・大文字小文字を同一視、XML エスケープ解除) →
  形式検査 (1 行複数要素 / CDATA / 入れ子 / 閉じタグ欠落 / </Project> なしは unsupported) →
  挿入位置。対象は Compile を含む最初の **Condition なし** ItemGroup の末尾 (Condition 付きに
  入れると条件付きコンパイルになるため除外)。新 ItemGroup は最後の ItemGroup の直後
  (皆無なら </Project> 直前)、インデントは最後の ItemGroup に合わせ子は +2 (既存の複数行
  Compile から増分を推定、なければ 2 スペース = VS 既定の 4 スペース)。
  SubType は `Inherits [System.][Windows.Forms.](Form|UserControl)` を内容から検出。
  Designer.vb には SubType を付けない (VS の生成物と同じ)。DependentUpon は親 X.vb が同じ
  changes.md で create されるか **既にディスクにある** とき (設計書は前者のみだが後者も
  VS の意味論どおりで推測ではない)。登録順は X.vb → X.Designer.vb (安定ソート)。
  同じ changes.md が .vbproj 自体を変更する場合は変更後の内容に登録を重ね、manifest は
  AI 側の op のまま `registered` を付ける (エントリは 1 つ)。純登録は `op: "vbproj"`
  (ManifestOp = Operation | "vbproj"。undo は replace と同じ before 復元)。
  Include の Shift_JIS 変換不能文字 / symlink / ルート外 / decode 不能は未登録として理由表示。
  登録の失敗は create の成否に影響しない (plan.ok 不変)。無効化は config `vbproj.register`
  と `--no-vbproj`
- **P1-b: newFile.encoding "auto"** (core/new-file-style.ts + infra/new-file-style.ts)。
  作成先ディレクトリの手本 (同拡張子優先 → 任意のテキスト → 上位へ 1 段ずつ) の多数決。
  手本の条件: 通常ファイル・非ドットファイル・空でない・NUL を含まない・decodeFile 可能・
  1 MiB 以下・1 ディレクトリ 100 件まで。同点は utf8 / BOM あり / crlf 側。
  手本なしは .vb → utf8+BOM+crlf、他 → utf8/lf。.vb で utf8 かつ BOM なしなら BOM 付与
  (ユーザーが bom を明示していれば付けない)。planChangeSet の第 3 引数は
  `NewFileConfig | (change) => NewFileConfig` (auto の解決は commands 層。core は I/O なし)。
  config の合成: encoding "auto" のときは既定の eol: "lf" を混ぜない (mergeNewFile)。
  従来形式 (eol のみ指定等) は従来どおり既定とマージ。init の雛形は `{ "encoding": "auto" }`
  + `"vbproj": { "register": true }`。ルート直下の changes.md も手本に数えられる
  (テストでは changes.md をルートの外に置く)
- **§11.4 規約文 v4**: 厳守事項 3 に「一意に特定できる範囲のうち最小 (目安 3〜8 行)」を追記
  (PROTOCOL_VERSION=4、利用者は init 再実行)

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

### ブラウザ差分レポートのセキュリティ設計 (2026-08-12、v0.13.0 で閲覧専用に縮小)

- VS Code が無いときの `show` は自己完結 HTML (core/diff-html.ts) を一時ファイルに書いて
  既定ブラウザで開くだけ。JS ゼロ・外部リソースゼロ・インライン CSS のみで、meta CSP は
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`。
  未変更範囲の折りたたみも <details> (JS 不要)。補間はすべて escapeHtml、表示テキストは
  双方向制御文字 (Trojan Source) を除去
- v0.4.0〜v0.12.0 にあったブラウザ編集 (127.0.0.1 の編集サーバー + 同梱 Monaco Editor) は
  v0.13.0 で削除 (上記「同梱サードパーティなし」)。実装の経緯 (トークン照合・CSP・
  Monaco 0.56 の日本語 NLS ハング・textarea の加工禁止など) は v0.12.0 以前の
  CLAUDE.md / git 履歴を参照
- VS Code 不在判定は ENOENT に加え **EINVAL** (CVE-2024-27980 対応後の Node は
  .cmd/.bat をシェル非経由で spawn できない)。それ以外の起動失敗は従来通り exit 1。
  `--edit` は VS Code 不在でもブラウザへ落とさず exit 1 (git の差分とエディタで直す案内)
- 静的レポートの一時 HTML (tmpdir の petari-report-*) はコード平文を含むため、
  次回 show 実行時に 1 時間より古いものを自動削除 (閲覧中かもしれない直近分は残す。
  対象は接頭辞一致のディレクトリのみ、symlink は Dirent 判定で除外)
- infra/browser.ts (open / xdg-open / Start-Process) は自動テストなし
  (clipboard.ts と同じく実機確認)

## メモ

- npm へ publish 済み (v0.1.0: 2026-08-08 / v0.2.0: 2026-08-11 規約文 v2 / v0.3.0: 2026-08-11 冪等性対応 /
  v0.4.0: 2026-08-12 ブラウザ差分ビュー — Monaco 同梱で tarball 5.7MB に増加 /
  v0.4.1: 2026-08-12 一時レポートの自動掃除 /
  v0.5.0: 2026-08-22 寛容パース + 規約文 v3 + 失敗レポート自動コピー /
  v0.6.0: 2026-08-25 失敗レポートの診断拡充 /
  v0.7.0: 2026-08-25 空行診断 — ギャップ許容アラインメント + 修正ヒント + init の removeEmptyLines 検知 /
  v0.8.0: 2026-08-30 空行差無視マッチ — SEARCH マッチング 4 段目 blank-insensitive + 結果表示の注記 + レポート文言の追従 /
  v0.9.0: 2026-09-12 slnmix 設計書 §11 — create した .vb の .vbproj 自動登録 + newFile.encoding "auto" + 規約文 v4。
  **ただし v0.9.0 の tarball は dist/ が v0.8.0 のままの不良パッケージ** (下記) /
  v0.9.1: 2026-09-14 v0.9.0 の再公開 + prepublishOnly 追加 /
  v0.10.0: 2026-09-29 二重適用の防止 / v0.11.0: 2026-10-11 init --no-repomix (slnmix init 用) /
  v0.12.0: 2026-10-11 petari watch /
  v0.13.0: 2026-10-28 ブラウザ編集 (Monaco 同梱) を削除 — パッケージ展開後 24.8MB → 約 0.3MB。
  あわせて macOS / Linux で npx petari が何もせず終わる不具合 (bin の symlink 起動) を修正。
  **ただし v0.13.0 の tarball には削除したソースの古いビルド (dist/infra/diff-server.js 等 3 件) が
  残っている** (下記。どこからも import されないため動作には影響なし) /
  v0.13.1: 2026-10-29 build が dist/ を消してから tsc するよう修正した再公開 /
  v0.14.0: 2026-10-31 伏せ字 [MASKED] の扱い — 失敗レポートの抜粋を伏せる + 伏せ字の行の照合と元の値への復元)。リポジトリ: https://github.com/ishibashi0112/petari
  リリース手順: version を上げて `pnpm publish` (`prepublishOnly` が typecheck → test → build を実行。認証はユーザー)
- **publish 事故と再発防止 (2026-09-14)**: v0.9.0 は `package.json` の version だけ 0.9.0 で、
  同梱 dist/ が v0.8.0 のビルド (PROTOCOL_VERSION=3、vbproj / new-file-style 系のファイルが欠落)
  だった。原因は petari に `prepublishOnly` がなく、`pnpm publish` が**ディスク上の dist/ を
  そのまま**固めたこと (slnmix には元からあり無事だった)。対策として
  `"prepublishOnly": "pnpm typecheck && pnpm test && pnpm build"` を追加。
  npm は同一バージョンの上書きを許さないため v0.9.1 として再公開し、v0.9.0 は
  `npm deprecate` で使わないよう案内する。**publish 後は必ず
  `npm pack <name>@<version>` で中身 (版数・新規ファイルの有無) を検証すること**
- **削除したソースの古いビルドの混入 (2026-10-29)**: v0.13.0 の tarball に、v0.13.0 で消した
  diff-server / editor-html / edit の古い .js が入っていた (43 件。正しくは 40 件)。tsc は
  ソースを消しても出力済みの .js を消さず、`files: ["dist"]` がそれを拾うため。動作には
  影響しないが、待ち受けサーバーのコードが tarball に残ると導入審査の説明 (待ち受けなし) と
  食い違う。対策として `build` の先頭で dist/ を消す (依存を増やさないよう `node -e` の
  fs.rmSync)。ソースを消すリリースでは、publish 後の `npm pack` でファイル数も確かめる
- 大きい変更の後は fallow (`npx -y fallow security` / `npx -y fallow`) で確認を取る運用
  (2026-08-08 初回実行: 実害指摘ゼロ。clipboard.ts の spawn 指摘は誤検知と検証済み。
  2026-08-12 ブラウザ差分ビュー追加後: diff-server.ts の writeHead 指摘 (CWE-113) は
  ヘッダ値がリテラル定数・自前生成乱数 (hex/base64 で CR/LF を含み得ない)・検証済み整数
  のみのため誤検知と検証済み。JS 解禁後の再実行でも同族のみ。
  2026-08-25 失敗レポート診断拡充後の再実行: 既知の誤検知 2 族 (clipboard spawn /
  diff-server writeHead) のみで、新規コード (nearest/report/applier) への指摘なし。
  同日の空行診断 (アラインメント化) + init の removeEmptyLines 検知追加後の再実行も同結果。
  2026-08-30 blank-insensitive マッチ追加後の再実行も既知の誤検知 2 族のみで同結果。
  2026-09-12 .vbproj 自動登録 + newFile auto 追加後の再実行: diff-server writeHead の既知
  誤検知のみで、新規コード (vbproj / new-file-style / vbproj-register) への指摘なし。
  2026-10-28 v0.13.0 (ブラウザ編集の削除) 後の再実行: diff-server.ts の削除で writeHead の
  誤検知族は消え、clipboard spawn の既知誤検知のみ。2026-10-31 v0.14.0 (伏せ字の扱い) 後の再実行も
  clipboard spawn の既知誤検知のみで、新規コード (mask / applier の変更) への指摘なし)
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
