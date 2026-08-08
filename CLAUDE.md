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
- 許容済みの残リスク: 検証と書き込みの間の TOCTOU (単独利用 CLI のため)

## メモ

- npm への publish は未実施。package.json は publish 可能な形 (files: dist, bin)。
  ユーザーの npm 認証を得てから `pnpm build && pnpm publish` で名前を確保する
- クリップボード実装 (pbcopy/pbpaste, PowerShell) は自動テストなし (実機確認のみ)。
  Windows 実機での Get-Clipboard / reg query / Known Folder の動作確認が未了
