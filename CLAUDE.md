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
- 開発依存も最小: typescript / vitest / @types/node のみ。tsx 不使用 (Node 24 ネイティブ TS 実行)
- pnpm-workspace.yaml の `minimumReleaseAge: 10080` (7日) で新規公開バージョンを遅延取得

### レイヤ構成

- `src/core/` — **純粋ロジックのみ。ファイル I/O 禁止** (文字列/Buffer in → 結果 out)。parser / matcher / encoding / report。テスト最厚領域 (§6, §8)
- `src/infra/` — I/O 層。history / config / root / downloads / clipboard / git
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
  ANSI エスケープ注入対策)。`process.stdout.write` 直書きは protocol (信頼済み同梱テキスト) のみ可
- 子プロセスは常に execFile/spawn の配列引数 (シェル非経由)。PowerShell へ渡すパスは
  単一引用符 + `''` エスケープ
- 再監査 (2 回目) での追加: vscodeCommand の UNC 拒否 / 予約名判定は末尾ドット・空白を
  除去してから照合 / サニタイズに双方向制御文字 (Trojan Source) を追加 /
  config 値の実行時検証 (`validateConfig`)
- 許容済みの残リスク: 検証と書き込みの間の TOCTOU (単独利用 CLI のため)、
  vscodeCommand の絶対パス指定 (正規ユースのため許可。攻撃には事前のローカル侵害が必要)

## メモ

- npm へ publish 済み (v0.1.0: 2026-08-08 / v0.2.0: 2026-08-11 規約文 v2 / v0.3.0: 冪等性対応・未 publish)。リポジトリ: https://github.com/ishibashi0112/petari
  リリース手順: version を上げて `pnpm typecheck && pnpm test && pnpm build && pnpm publish` (認証はユーザー)
- 大きい変更の後は fallow (`npx -y fallow security` / `npx -y fallow`) で確認を取る運用
  (2026-08-08 初回実行: 実害指摘ゼロ。clipboard.ts の spawn 指摘は誤検知と検証済み)
- クリップボード実装 (pbcopy/pbpaste, PowerShell) は自動テストなし (実機確認のみ)。
  Windows 実機での Get-Clipboard / reg query / Known Folder の動作確認が未了
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
