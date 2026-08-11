# petari

**petari — paste AI chat patches onto your codebase**
**petari — AIチャットの返答を、コードベースにぺたり。**

チャットベース AI (M365 Copilot Chat 等) の返答を、ローカルのコードベースへ安全に一括適用する CLI ツールです。
AI に規約形式の変更指示ファイル (changes.md) を出力させ、petari がパース・検証して適用します。
レビューは Git の未コミット差分として VS Code で行い、適用の履歴 (before/after/指示原本) は
`.petari/history/` に自動保存されます。

## インストール

```sh
pnpm add -g petari   # または npx petari
```

## 使い方

```sh
petari init              # プロジェクト初回セットアップ (protocol.md / 設定 / repomix 連携 / .gitignore)
repomix                  # 規約文入りのコンテキストを生成して AI チャットに渡す
                         # → AI から changes.md をダウンロード
petari                   # Downloads の changes.md を自動検出して適用
git diff                 # VS Code で差分レビュー・手修正
petari undo              # 直近の適用を巻き戻す
```

### slnmix 連携 (レガシー VB.NET プロジェクト)

[slnmix](https://www.npmjs.com/package/slnmix) v0.7.0 以降は、入力 (.sln / .vbproj) と
同じディレクトリにある `protocol.md` を出力末尾に自動で連結します (repomix の
`instructionFilePath` 相当。別の場所に置く場合は `--instruction-file <path>`)。

```sh
npx petari init      # protocol.md を生成 (.sln と同じプロジェクト直下に)
npx slnmix           # .sln を解析。出力末尾に規約文が自動で付く
                     # → 出力を M365 Copilot Chat に貼る
petari               # 返答 (changes.md) を適用
```

**変更を依頼するメッセージには、必ず次の 1 行を添えてください。**
貼り付け本文に埋め込まれた規約文は、チャットサービス側の要約・検索処理で
モデルに届かなかったり、チャット本文の指示より弱く扱われたりすることがあります
(埋め込みだけで確実に認識させる方法はありません)。

> 変更は、貼り付けた内容の末尾にある規約 (instruction) に従って changes.md として出力してください。

petari の更新で規約文が変わった場合は、`petari init` を再実行すると protocol.md の
差分を検出して更新を提案します (slnmix 側の更新は不要)。

### コマンド

| コマンド | 説明 |
|---|---|
| `petari [path]` | changes.md を適用。省略時は Downloads とプロジェクト直下から自動検出 (直近 30 分)。`--clip` でクリップボードから |
| `petari undo [ID]` | 履歴を巻き戻す (手修正がある場合は警告) |
| `petari show <ID>` | VS Code の差分ビューで履歴を表示。`--mine` で適用後の手修正分、`--changes` で変更概要 |
| `petari list` | 履歴の一覧と合計サイズ |
| `petari protocol` | AI への規約文を標準出力に出す (slnmix / repomix 連携用) |
| `petari init` | プロジェクト初回セットアップ (`--yes` で全提案に同意) |

主なオプション: `--dry-run` (検証と差分プレビューのみ) / `--partial` (成功分のみ適用) /
`--root <dir>` / `--yes` / `--clip-report` (失敗レポートをクリップボードへ)

## 特徴

- **all-or-nothing**: 全ブロックを事前検証し、1 つでも失敗があれば何も書き込まない
- **冪等 (再実行に安全)**: SEARCH が見つからなくても REPLACE の内容が既にファイルに
  存在すれば「適用済み」として成功扱いでスキップ。同じ changes.md を 2 回実行しても
  失敗せず、適用済み・未適用が混在していても未適用分だけを適用する。
  結果は `適用 / 済み / 失敗` の 3 状態で表示
- **エンコーディング保全**: Shift_JIS / UTF-8 (BOM 有無)・CRLF / LF・末尾改行を完全維持。
  変更していない行は元のバイト列をそのまま書き戻す (レガシー VB.NET 資産でも安全)
- **失敗レポート**: そのまま AI チャットに貼り返せる形式で出力。再依頼が 1 コピペで済む
- **実行時依存ゼロ**: サプライチェーン対策として外部パッケージに依存しない
  (Shift_JIS 変換テーブルも Node 組み込み ICU から自動生成して同梱)

## セキュリティ設計

社内利用の審査 (情報システム部門のレビュー等) を想定した要点です。

### 通信・依存関係

- **実行時のネットワーク通信は一切行いません**。AI との通信機能はなく、入力はローカルファイル
  またはクリップボードのみ。テレメトリ・自動更新もありません
- **実行時依存パッケージはゼロ**です。npm のインストールスクリプト (postinstall 等) も
  使用しません。Shift_JIS 変換テーブルは Node.js 組み込みの ICU から生成しリポジトリに
  同梱しています (外部データの取り込みなし)
- 子プロセスの起動はすべて `execFile`/`spawn` の配列引数で行い、シェルを経由しません
  (コマンドインジェクション不成立)。起動するのは `git` / `reg` / `powershell` /
  `pbcopy`・`pbpaste` / VS Code (`code`) のみです

### 入力の取り扱い (信頼境界)

changes.md (AI 出力)・クリップボード・リポジトリに同梱され得る `.petari/` 内のファイルは
**すべて非信頼入力**として扱います。

- 書き込み先パスは**プロジェクトルート相対のみ**。絶対パス・UNC・ドライブレター・`..`・`~`・
  `:` (NTFS 代替データストリーム)・Windows 予約デバイス名 (CON/NUL/COM1 等、末尾ドット・
  空白による偽装を含む) を拒否します
- シンボリックリンク自体の書き換えに加え、**symlink ディレクトリ経由でルート外へ出るパスも
  realpath 検証で拒否**します
- パス検証は apply だけでなく undo / show (履歴 manifest 由来のパス) にも適用します
- 端末出力は制御文字 (ANSI エスケープ・双方向制御文字 = Trojan Source) を除去してから
  表示します (表示偽装対策)
- 差分ビューアのコマンド (`vscodeCommand` 設定) は PATH 上のコマンド名か絶対パスのみ許可し、
  リポジトリ内スクリプトを指せる相対パスと UNC パスを拒否します

### 適用の安全弁と監査性

- 全変更を**事前検証してから書き込む all-or-nothing** (1 件でも失敗すれば何も書かない)。
  `--dry-run` で書き込みなしの事前確認が可能
- すべての適用は `.petari/history/` に **適用前後のファイル・指示原本・SHA-256 付き
  manifest** として記録され、`petari undo` で巻き戻せます (監査証跡)
- Git 作業ツリーに未コミット変更がある場合は警告し、適用前に確認を求めます

### 既知の検知可能性・残リスク

- Windows でクリップボード機能 (`--clip` / `--clip-report`) を使うと
  `node.exe → powershell.exe (Get-Clipboard / Set-Clipboard)` の親子プロセスが発生し、
  **EDR がログ・アラート対象にする可能性があります** (ユーザー起点の単発実行です。
  PowerShell が制限された環境ではクリップボード機能のみ失敗し、ファイル入力は動作します)
- 検証と書き込みの間の TOCTOU (ファイル差し替え) は検出しません (単独利用の CLI として許容)
- 履歴には対象ファイルの複製が平文で保存されます。`.petari/` は `.gitignore` 推奨
  (init が自動提案) で、リポジトリには含まれません

## 開発

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # dist/ へビルド
```

設計方針・規約は [CLAUDE.md](CLAUDE.md)、仕様の正本は [requirements.md](requirements.md) を参照。

## License

MIT
