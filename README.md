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

### コマンド

| コマンド | 説明 |
|---|---|
| `petari [path]` | changes.md を適用。省略時は Downloads から自動検出 (直近 30 分)。`--clip` でクリップボードから |
| `petari undo [ID]` | 履歴を巻き戻す (手修正がある場合は警告) |
| `petari show <ID>` | VS Code の差分ビューで履歴を表示。`--mine` で適用後の手修正分、`--changes` で変更概要 |
| `petari list` | 履歴の一覧と合計サイズ |
| `petari protocol` | AI への規約文を標準出力に出す (slnmix / repomix 連携用) |
| `petari init` | プロジェクト初回セットアップ (`--yes` で全提案に同意) |

主なオプション: `--dry-run` (検証と差分プレビューのみ) / `--partial` (成功分のみ適用) /
`--root <dir>` / `--yes` / `--clip-report` (失敗レポートをクリップボードへ)

## 特徴

- **all-or-nothing**: 全ブロックを事前検証し、1 つでも失敗があれば何も書き込まない
- **エンコーディング保全**: Shift_JIS / UTF-8 (BOM 有無)・CRLF / LF・末尾改行を完全維持。
  変更していない行は元のバイト列をそのまま書き戻す (レガシー VB.NET 資産でも安全)
- **失敗レポート**: そのまま AI チャットに貼り返せる形式で出力。再依頼が 1 コピペで済む
- **実行時依存ゼロ**: サプライチェーン対策として外部パッケージに依存しない
  (Shift_JIS 変換テーブルも Node 組み込み ICU から自動生成して同梱)

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
