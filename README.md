# tazuna

**AI に手綱を渡さずに、AI と開発する。**
**Build with AI chat, without handing over the reins.**

チャットベース AI (M365 Copilot Chat 等) で開発するための CLI ツールです。名前は「手綱 (たづな)」から。
AI エージェントは手綱を AI に渡し、AI が PC の上でファイルを書き換えたりコマンドを実行したりするのを、人が承認しながら見守ります。
tazuna では AI はあなたの PC に一切触れません。コードを渡すのも、返答を確かめて当てるのも、ビルドするのも
手元の tazuna で、手綱はずっと人が握ったままです。1 つのコマンドで、往復の両側を受け持ちます。

1. **渡す** (`tazuna pack`): プロジェクトのソースを 1 ファイル (パック) にまとめ、チャットに貼る指示文
   (作業手順・出力規約) と一緒にクリップボードへ入れる。認証情報らしき値は `[MASKED]` に伏せる
2. **当てる** (`tazuna`): AI に規約形式の変更指示ファイル (changes.md) を出力させ、tazuna がパース・検証して
   適用する。レビューは Git の未コミット差分として VS Code で行い、適用の履歴 (before/after/指示原本) は
   `.tazuna/history/` に自動保存される
3. **直す** (`tazuna build`): MSBuild でビルドし、失敗したらエラーと今のファイルの周辺行をクリップボードへ入れる

レガシー VB.NET (`.sln` / `.vbproj`、Shift_JIS) を出発点にしていますが、TypeScript・Python・C#・Go などの
プロジェクトでも使えます (git が管理しているファイルをまとめる)。実行時依存はゼロで、通信もしません
(導入審査向けの説明は [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md))。

0.15.0 で、変更を当てる側だった petari と、パックを作る側だった [slnmix](https://www.npmjs.com/package/slnmix) を
1 つにして tazuna に改名しました (下記「petari / slnmix から移るとき」)。

## インストール

```sh
pnpm add -g tazuna   # または npx tazuna
```

Node.js 20.19 以降が必要です。

## 使い方

```sh
npx tazuna init          # 初回だけ (リポジトリ直下で)。構成の判定・docs/・.gitignore・.tazuna/ をまとめて準備
npx tazuna pack          # パックを作り、Copilot Chat に貼るものをクリップボードへ
                         # → 本文に貼って送信 (パックが大きいときは repomix-output.xml を添付)
                         # → AI から changes.md をダウンロード
npx tazuna               # Downloads の changes.md を自動検出して適用
git diff                 # VS Code で差分レビュー・手修正
npx tazuna build         # (VB.NET) ビルドし、失敗ならエラーと周辺のコードをクリップボードへ → チャットに貼る
npx tazuna undo          # 直近の適用を巻き戻す
```

日々の流れ (設計から実装・引継ぎまで) は [docs/WORKFLOW.md](docs/WORKFLOW.md)、
パックの機能 (UI サマリー・パスの規則・ハイブリッド構成・VB.NET 以外・作業手順・docs/ 連携・
ビルドエラー) は [docs/PACK.md](docs/PACK.md) にまとめています。

往復が続くときは、別の端末で `tazuna watch` を起動しておくと、ダウンロードした
changes.md が届くたびに確認なしで適用されます (毎回 `tazuna` を打たなくてよくなります)。
失敗したときはレポートがクリップボードに入るので、そのまま AI に貼り返します。
止めるときは Ctrl+C です。ブラウザのダウンロード先とコードが同じ PC にあることが前提で、
RDP 越しに受け渡す運用では従来どおり `tazuna` / `tazuna --clip` を使います。

**変更を依頼するメッセージには、必ず次の 1 行を添えてください** (`tazuna pack` が作る本文用テキストには
既に入っています)。貼り付け本文に埋め込まれた規約文は、チャットサービス側の要約・検索処理で
モデルに届かなかったり、チャット本文の指示より弱く扱われたりすることがあります
(埋め込みだけで確実に認識させる方法はありません)。

> 変更は、貼り付けた内容の末尾にある規約 (instruction) に従って changes.md として出力してください。

規約文は tazuna に内蔵されていて、tazuna を更新すれば最新の版になります (`npx tazuna protocol` で表示)。
ルートに `protocol.md` を置くと、その内容で上書きできます。本家 repomix など他のツールでパックを作る場合は、
`npx tazuna protocol` の出力を規約文として渡してください。

### petari / slnmix から移るとき

| 以前 | 今 |
|---|---|
| `npx slnmix init` / `npx petari init` | `npx tazuna init` (1 つにまとまりました) |
| `npx slnmix [入力] [オプション]` | `npx tazuna pack [入力] [オプション]` (オプションは同じ名前) |
| `npx slnmix build` | `npx tazuna build` |
| `npx petari [path]` / `watch` / `undo` / `show` / `list` / `protocol` | `npx tazuna [path]` / `watch` / … (引数は同じ) |

- 適用の履歴と PC ごとの設定の `.petari/` は、そのまま使われます (`.petari/` だけがあるリポジトリでは
  `.tazuna/` を作らずに `.petari/` を使い続けます。新しく始めるリポジトリは `.tazuna/`)。PC 全体の設定
  (`%APPDATA%\petari\config.json` など) も、`tazuna` のものが無ければ読まれます
- 設定ファイルは `tazuna.config.json` になりました。`slnmix.config.json` は名前を変えなくても読まれます
  (両方あるとエラー)
- `protocol.md` は手を加えていなければ消してかまいません (`npx tazuna pack` が案内します)
- ルートの決め方がパックと適用で同じになりました (`--root` > 上に向かって最初の設定ファイル > リポジトリ直下 >
  入力の場所)。設定ファイルの無いプロジェクトで `.sln` がリポジトリ直下より下にあると、パックの
  `<file path>` の先頭にフォルダ名が付くようになります (変更を当てるときのパスと一致する方向の変更です)
- 出力はツール名の行だけが変わります (手順文の版は同じ。設計書の状態行 `<!-- slnmix design: ... -->` もそのまま)
- `npx petari` と `npx slnmix` もしばらくは動きます (tazuna を呼ぶだけの互換パッケージ。実行のたびに
  移行を知らせる 1 行が出ます)

### レガシー VB.NET プロジェクトでの適用

#### 新規 .vb ファイルの作成

AI が `create` で `.vb` を新規作成すると、tazuna が次を自動で行います (Visual Studio での
手作業をなくすため)。いずれも失敗しても create 自体は成功し、理由を結果表示に出します。

- **旧スタイル .vbproj への登録**: 作成先から上へ辿って最寄りの `.vbproj` を探し、
  `<Compile Include="...">` を追加します (`Inherits Form` なら `<SubType>Form</SubType>`、
  `X.Designer.vb` なら `<DependentUpon>X.vb</DependentUpon>` 付き)。追加行以外のバイト列は
  変えません (Shift_JIS / CRLF / BOM そのまま)。SDK スタイルの `.vbproj` は登録不要のため
  触りません。登録は履歴に含まれ `tazuna undo` で戻ります。無効化は `--no-vbproj` か
  `.tazuna/config.json` (旧版から使っているリポジトリでは `.petari/config.json`。以下同じ) の
  `"vbproj": { "register": false }`
- **エンコーディングの推定**: `.tazuna/config.json` の `"newFile": { "encoding": "auto" }`
  (`tazuna init` の雛形の既定) で、同じディレクトリの既存ファイルの多数決で
  文字コード / BOM / 改行を決めます。`.vb` を BOM なし UTF-8 で作ることはありません
  (vbc / VS で日本語が化けるため)。従来どおり `"utf8"` / `"shift_jis"` の明示指定も使えます

### 適用が繰り返し失敗するとき

失敗レポート (自動でクリップボードにコピーされます) をそのまま AI に貼り返すのが
最短です。レポートには実ファイルの該当箇所の抜粋と、どの行がどう違うかの診断が
含まれるため、AI は推測ではなくコピーで SEARCH を直せます。

それでも同じ箇所が失敗を繰り返す場合は、**AI に渡したスナップショット (`tazuna pack` /
repomix の出力) が実ファイルとずれている**可能性が高いです。特にチャットサービスは
長い添付を要約・検索処理で部分的にしか読まないことがあり、AI が見えなかった箇所を
もっともらしく補って出力することがあります。SEARCH の空白調整や言い換えを繰り返す
より、スナップショットを取り直して渡し直すのが確実です (tazuna 側は空白・インデント・
空行の位置や数・文字コードの差を吸収して照合するため、それらが原因で失敗することは
ありません)。

### コマンド

| コマンド | 説明 |
|---|---|
| `tazuna init` | プロジェクト初回セットアップ (構成の判定・docs/・.gitignore・`.tazuna/config.json`。対話なし・冪等。`--yes` / `--no-repomix` は互換のため受け付けて無視) |
| `tazuna pack [入力]` | パックと本文用テキストを作り、貼るものをクリップボードへ (旧 slnmix。オプションは `tazuna pack --help`、説明は [docs/PACK.md](docs/PACK.md)) |
| `tazuna build [入力]` | MSBuild でビルドし、失敗ならエラーと周辺のコードをクリップボードへ (旧 slnmix build) |
| `tazuna [path]` | changes.md を適用。省略時は Downloads とプロジェクト直下から自動検出 (直近 30 分)。`--clip` でクリップボードから |
| `tazuna watch` | Downloads とプロジェクト直下を見張り、起動後に届いた changes*.md を確認なしで適用し続ける (Ctrl+C で終了)。`--dry-run` で検証とプレビューだけ |
| `tazuna undo [ID]` | 履歴を巻き戻す (手修正がある場合は警告)。ID 省略で続けて実行すると 1 つずつ前の適用へ戻る |
| `tazuna show [ID]` | 履歴の差分を表示 (VS Code、なければブラウザの閲覧レポートにフォールバック)。`--edit` で現在のファイルを差分を見ながら手修正 (VS Code のみ)、`--mine` で適用後の手修正分、`--changes` で変更概要、`--browser` でブラウザ強制 |
| `tazuna list` | 履歴の一覧と合計サイズ |
| `tazuna protocol` | 内蔵の規約文を標準出力に出す (`protocol.md` で上書きするときの元・他のツールでパックを作るとき用) |

適用の主なオプション: `--dry-run` (検証と差分プレビューのみ) / `--partial` (成功分のみ適用) /
`--root <dir>` / `--yes` / `--clip-report` (失敗レポートをクリップボードへ。v0.5.0 から既定で自動コピーされるため、config で無効化した場合の個別指定用) /
`--no-vbproj` (create した .vb の .vbproj 自動登録を今回だけ無効化) /
`--force` (適用済みの changes.md でも再適用する。下記「二重適用の防止」を今回だけ解除) /
`--literal-masked` (元の値に戻せない `[MASKED]` をその文字のまま書く。伏せ字を扱うコードそのものを書くとき用。下記「伏せ字 [MASKED] の扱い」)

## 特徴

- **all-or-nothing**: 全ブロックを事前検証し、1 つでも失敗があれば何も書き込まない
- **冪等 (再実行に安全)**: SEARCH が見つからなくても REPLACE の内容が既にファイルに
  存在すれば「適用済み」として成功扱いでスキップ。同じ changes.md を 2 回実行しても
  失敗せず、適用済み・未適用が混在していても未適用分だけを適用する。
  SEARCH の前後に行を足す追記型の変更も、足す行が既にあれば「適用済み」になる。
  結果は `適用 / 済み / 失敗` の 3 状態で表示
- **二重適用の防止**: 適用した changes.md の指紋を履歴に記録し、同じ changes.md を
  もう一度渡して書き込みが発生する場合は何も書かずに止める (ファイル名・前置き・改行コードが
  違っても同じ変更なら検出)。`tazuna undo` で戻したものは再適用でき、それ以外は `--force` で再適用
- **エンコーディング保全**: Shift_JIS / UTF-8 (BOM 有無)・CRLF / LF・末尾改行を完全維持。
  変更していない行は元のバイト列をそのまま書き戻す (レガシー VB.NET 資産でも安全)
- **規約逸脱への耐性 (寛容パース)**: AI がマーカーの記号数・見出しレベルを崩したり
  出力全体をコードフェンスで包んでも、厳密パース失敗時に限り安全な範囲で自動補正して
  解釈する (補正内容は適用前に全件表示。曖昧さが残る場合は採用せずエラーに戻す)
- **失敗レポート**: そのまま AI チャットに貼り返せる形式で出力し、**既定でクリップボードへ
  自動コピー** (失敗した時点で貼り返し 1 ペーストの状態。config の
  `clipReportOnFailure: false` で無効化可)。構文エラー時のレポートには規約フォーマットの
  要点を同梱 (チャット側で規約文が失われていてもレポート 1 枚で再出力を依頼できる)
- **伏せ字 [MASKED] の扱い**: `tazuna pack` はパックを作るとき認証情報らしき値を
  `[MASKED]` に伏せる (TypeScript / JavaScript・Java・C#・Go・Python は文字列とコメントの中だけ)。
  適用では失敗レポートの「実ファイルの該当箇所」を同じ規則で伏せ
  (AI に貼るレポートから実際の値が漏れない)、SEARCH の `[MASKED]` を伏せた後の実ファイルと
  照合し、書き込む行の `[MASKED]` を元の値に戻す。戻すのは、伏せ字を含む行を一字も変えずに
  残した (インデントだけ変わった) 行だけ。伏せ字を含む行を書き換えた・新しく足した・create・
  同じ表示で値の違う行が範囲に複数ある場合と、伏せ字を含む行を元より多く書く場合 (My.Settings の
  `<value>[MASKED]</value>` や設定のセクションを写して足すと、別のキーに同じ値が入るため) は、値を
  取り違えないよう書かずに止める。実ファイルに
  もともとある `[MASKED]` という文字の行は、残せばその文字のまま書く。`[MASKED]` という文字を
  新しく書く変更 (伏せる処理そのものの実装など) は `--literal-masked` を付けたときだけ書く
  (変更する範囲に実際の値を伏せた行があるとき・ファイルや行の移動で伏せていた値が減るときは、
  付けても使わない。実際の値を `[MASKED]` の文字で置き換えないため)。伏せ字を含む行を書く変更のどれかが
  書かれないとき (当てられない・戻せない・適用済みと判定した) は `--partial` でも、伏せていた値を消す変更
  (伏せ字の行を別のブロック・別のファイルへ移す回答の移動元など) は書かない
- **適用 1 回ごとの差分確認**: `show` は履歴の適用前後を VS Code の差分ビューで開く
  (VS Code がなければ JS を含まない自己完結 HTML レポートをブラウザで開く)。
  普段の確認は git の差分 (VS Code のソース管理など) で足り、`show` は undo 用の履歴を
  1 回分ずつ見たいとき向け。`show --edit` は VS Code の右ペインで現在のファイルを直接直せる。
  Windows では `.tazuna/config.json` の `vscodeCommand` に Code.exe の絶対パス
  (例: `C:/Users/<ユーザー名>/AppData/Local/Programs/Microsoft VS Code/Code.exe`) を書く
  (PATH にある code.cmd はシェルを通さずには起動できないため)
- **実行時依存ゼロ・同梱サードパーティなし**: サプライチェーン対策として npm の実行時依存
  パッケージを持たず、他者のコードも同梱しない (Shift_JIS 変換テーブルも Node 組み込み ICU
  から自動生成して同梱。XML・.gitignore の読み取りも自前)。パッケージは自前のビルド結果 (dist/) のみ

## セキュリティ設計

社内利用の審査 (情報システム部門のレビュー等) を想定した要点です。データの流れ・パックに入るもの・
認証情報の伏せ方・起動する外部コマンド・残るファイルを含む全体の説明は
[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) にあります。

### 通信・依存関係

- **ネットワーク通信は一切行いません**。AI との通信機能はなく、入力はローカルファイル
  またはクリップボードのみ。テレメトリ・自動更新もなく、ポートの待ち受けもしません
  (v0.12.0 まであったブラウザ編集用の 127.0.0.1 の一時サーバーは v0.13.0 で廃止)
- **実行時依存パッケージはゼロ**です。npm のインストールスクリプト (postinstall 等) も
  使用しません。Shift_JIS 変換テーブルは Node.js 組み込みの ICU から生成しリポジトリに
  同梱しています (外部データの取り込みなし)
- **同梱サードパーティもありません** (v0.12.0 まで同梱していた Monaco Editor は v0.13.0 で
  削除)。パッケージの中身は自前のビルド結果 (dist/) のみです
- 子プロセスの起動はすべて `execFile`/`spawn` の配列引数で行い、シェルを経由しません
  (コマンドインジェクション不成立)。起動するのは `git` / `reg` / `powershell` /
  `pbcopy`・`pbpaste`・`xclip` / VS Code (`code`) / 既定ブラウザ起動 (`open` / `xdg-open` /
  PowerShell `Start-Process`) と、`tazuna build` のときの `vswhere` / `MSBuild` のみです

### 入力の取り扱い (信頼境界)

changes.md (AI 出力)・クリップボード・リポジトリに同梱され得る `.tazuna/` (旧版の `.petari/`) 内のファイルは
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
- すべての適用は `.tazuna/history/` に **適用前後のファイル・指示原本・SHA-256 付き
  manifest** として記録され、`tazuna undo` で巻き戻せます (監査証跡)
- Git 作業ツリーに未コミット変更がある場合は警告し、適用前に確認を求めます
- 失敗レポート (AI に貼り返す前提) の実ファイルの抜粋は、認証情報らしき値を `[MASKED]` に
  伏せてから載せます。伏せ字のまま書き込んで実際の値を消すこともありません (戻せなければ止める)

### 既知の検知可能性・残リスク

- Windows でクリップボード機能 (`--clip` / `--clip-report`) を使うと
  `node.exe → powershell.exe (Get-Clipboard / Set-Clipboard)` の親子プロセスが発生し、
  **EDR がログ・アラート対象にする可能性があります** (ユーザー起点の単発実行です。
  PowerShell が制限された環境ではクリップボード機能のみ失敗し、ファイル入力は動作します)
- 検証と書き込みの間の TOCTOU (ファイル差し替え) は検出しません (単独利用の CLI として許容)
- 履歴には対象ファイルの複製が平文で保存されます。`.tazuna/` は `.gitignore` 推奨
  (init が自動提案) で、リポジトリには含まれません
- ブラウザ表示用の差分レポート (HTML。JS を含まない閲覧専用) はコードの中身を平文で含み、
  本人のみ読める一時ディレクトリ (0700) に書き出されます。1 時間より古いものは次回の
  `show` 実行時に自動削除されます (閲覧中かもしれない直近分は残す)

## 開発

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # dist/ へビルド
```

設計方針・規約は [CLAUDE.md](CLAUDE.md)、適用の仕様の正本は [requirements.md](requirements.md)、
パックと統合の設計は [docs/HANDOFF-slnmix-petari-2026-09.md](docs/HANDOFF-slnmix-petari-2026-09.md) を参照。

## License

MIT
