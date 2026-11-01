# tazuna pack — パックの詳細

`tazuna pack` は、プロジェクトのソースを Repomix 互換フォーマットの 1 ファイル(パック)にまとめ、
AI チャットに貼る本文用テキストと一緒に出します。レガシー Visual Studio(`.sln` / `.vbproj`)は
**ビルド対象の論理構成**で、それ以外の言語は git が管理しているファイルでまとめます。

0.15.0 より前は slnmix という別のパッケージでした(変更を当てる側の petari と 1 つにして tazuna に改名。
`npx slnmix` → `npx tazuna pack`、
`npx slnmix build` → `npx tazuna build`、`npx slnmix init` → `npx tazuna init`。オプションは同じ名前)。
日々の操作の流れは [WORKFLOW.md](WORKFLOW.md) を見てください。このページは機能ごとの説明です。

## 本家 repomix との違い

[repomix](https://github.com/yamadashy/repomix) はディレクトリを走査してファイルを集めます。
レガシー Visual Studio(VB.NET / VS2013 世代)のプロジェクトでは、それだと困ることがあります。

- `<Link>` でプロジェクト外・別ドライブに置かれたソースを**拾えない**
- ビルド対象外のファイル(過去の残骸・バックアップ)を**拾ってしまう**
- `Designer.vb` / `.resx` などの自動生成ファイルがノイズになる

`tazuna pack` は `.sln` → `.vbproj` を静的解析し、**ビルド対象の論理構成**(Link・
DependentUpon 解決済み)に基づいてエクスポートします。

主な特徴:

- 文字コードを自動判定(BOM / UTF-8 / Shift_JIS(CP932))して UTF-8 に統一
- 認証情報らしき値(`Password=` / APIキー等)を既定で `[MASKED]` に自動置換
  (`パスワード` / `ﾊﾟｽﾜｰﾄﾞ` 等の日本語変数名・キー名、メソッド引数
  `Login("...", "...")`、UI サマリー生成前の Designer ソースにも適用)。
  設定ファイルの appSettings(`<add key="DbPassword" value="..." />`)・My.Settings・
  JSON の `"password": "..."`・`DB_PASSWORD=...` の値も伏せる。TypeScript / JavaScript・Java・C#・Go・Python は
  文字列とコメントの中だけを伏せ、`process.env.API_KEY` のようなコードは伏せない
- 既定で厳格モード: ランダムな英数字列(高エントロピー値)も機械的にマスク
  (`--no-strict-mask` で無効化)。出力ヘッダーには AI 向けに
  「[MASKED] は伏せ字」であることと取り扱いの指示を明記。`tazuna build` のエラーの
  文面も同じ規則で伏せる。変更を当てるときは、回答で `[MASKED]` を含む行を
  一字も変えずに残した場合だけ元の値に戻して書き込み、書き換えた・足した場合は止める
- `.gitignore` / `.repomixignore` を尊重(本家 repomix と同じ挙動)
- Designer 関連・`.resx` は既定で除外(オプションで含められる)
- 除外した `*.Designer.vb` は **UI サマリー**として要約を自動埋め込み(下記)
- 除外・未解決のファイルは `<skipped_files>` に明記(黙って捨てない)
- SDK スタイル `.vbproj`(`<Project Sdk="...">`)は既定の Compile グロブ
  `**/*.vb` を展開して扱い、展開したことを出力に明記(下記)
- `<file path>` は**ルート相対の物理パス・`/` 区切り**(changes.md のパスとして
  そのまま使える形。Link は `logical` 属性で論理パスを併記。下記)
- 設定ファイル `tazuna.config.json`(旧名の `slnmix.config.json` も読む)の `extraRoots` で `.vbproj` に乗らない web / 契約
  ディレクトリを同じパックに入れられる(WinForms + WebView2 + React の
  ハイブリッド構成向け。生成コードは除外して `<contract_summary>` で代替。下記)
- `.sln` と同じフォルダに `.sln` から参照されていない `.vbproj` があれば警告
  (`.sln` だけが古い場合のエクスポート漏れに気付ける)
- changes.md の書き方の規約文(内蔵)を出力末尾に `<instruction>` として連結(下記)
- 「調査 → 方針 → 変更 → 自己検証」の**作業手順**を出力末尾に `<procedure>` として
  同梱し、`--task` で依頼内容も一緒に渡せる(下記)
- **プロジェクト文書の連携**(`docs/`): 設計書・仕様書・引継ぎ書をパックの `<docs>` と
  本文用テキストに自動で載せ、文書の状態から作業モード(設計 / 実装 / 続き)を
  自動で決める。文書の更新は AI が changes.md で出し `npx tazuna` が保存する(下記)
- VB.NET 以外(TypeScript・Python・C# など)は、git が管理しているファイルを既定でまとめる(下記)
- 出力は BOM 付き UTF-8(Windows 系ツールの誤判定防止)

## 導入の審査(情報システム部門向け)

[SECURITY-REVIEW.md](SECURITY-REVIEW.md) に、データの流れ・通信の有無・
依存パッケージ・起動する外部コマンド・残るリスクをまとめています。

## UI サマリー

Designer.vb の原文は座標・サイズの羅列でトークンを浪費しますが、丸ごと捨てると
AI は `Me.btnSave` が何なのか分からなくなります。`tazuna pack` は既定で、除外した
`*.Designer.vb` からコントロール構成だけを抽出して `<ui_summary>` として
フォーム本体のコードの直後に埋め込みます。

```xml
<ui_summary path="App\Forms\OrderForm.Designer.vb" form="OrderForm">
Designer 自動生成コードからの要約(コントロール名: 型 — Text。座標・サイズ等のレイアウトは省略):
フォームタイトル: "受注入力"
- pnlHeader: Panel
  - lblCustomer: Label — Text "得意先"
  - txtCustomerName: TextBox
- btnSave: Button — Text "保存"
- mnuMain: MenuStrip
  - mnuFile: ToolStripMenuItem — Text "ファイル(&F)"
    - mnuFileExit: ToolStripMenuItem — Text "終了(&X)"
- grdItems: FarPoint.Win.Spread.FpSpread
</ui_summary>
```

原文が必要な場合は `--include-designer`(サマリーの代わりに原文を出力)、
サマリー自体が不要なら `--no-ui-summary` を指定します。
特定のフォームだけ原文が必要な場合は `--include-designer-file <名前|パターン>`
(複数指定可)で選べます。指定しなかった Designer は従来どおり除外・要約
されるため、関係ないフォームで出力が膨らむのを避けられます。

```console
npx tazuna pack MyApp.sln --include-designer-file FormMain.Designer.vb --include-designer-file "FormOrder*"
```

## 初回セットアップ(`tazuna init`)

リポジトリの直下(`.git` のある場所)で一度だけ実行します。

```console
npx tazuna init
```

次をまとめて行います。対話はなく、既存のファイルは変えないので、何度実行しても同じです。

1. **構成の判定**: 設定ファイルがあればそのまま使います。無ければ、直下に `.sln` / `.vbproj` があれば
   設定は作りません。直下に無く、1 段下のフォルダ(例: `dotnet/`)に `.sln` が 1 つだけあれば
   `tazuna.config.json` の `target` に書きます。どちらも無ければ VB.NET 以外のプロジェクトとして
   `kind: "generic"` の設定を作ります(下記。`--init-config` と同じ)
2. **docs/ 連携**: `docs/design/` `docs/spec/` `docs/README.md` と `docs` 設定(`--init-docs` と同じ)
3. **.gitignore**: 生成物 `repomix-output.xml` / `repomix-output.prompt.md` と `.tazuna/` を追記
   (既存の規則で除外済みなら足しません。既存の行は書き換えず末尾に足します)
4. **`.tazuna/config.json`**: PC ごとの設定(Downloads の場所・VS Code のパス・履歴の上限など)の雛形
   (旧版の petari が作った `.petari/` だけがあれば、`.tazuna/` を作らずに `.petari/` をそのまま使います)
5. **規約文**: 内蔵なので書き出しません。以前の `slnmix init` / `petari init` が書いた `protocol.md` があれば、
   手を加えていないか(削除してよいか)を表示します

`.git` のあるフォルダより下で実行しても、リポジトリ直下(上に設定ファイルがあればその場所)を
セットアップします。changes.md のパスとパックの `<file path>` の基準をそこに揃えるためです。
`.sln` が 1 段下に複数あるときや、2 段以上深いときは、`tazuna.config.json` に
`"target": "<フォルダ>/<名前>.sln"` を書いてから実行してください。

`--init-docs` / `--init-config` は `tazuna pack` のオプションとして単独でも使えます。

## 使い方

```console
npx tazuna pack                  # カレントディレクトリの .sln を自動検出
npx tazuna pack C:\path\to\App   # 指定フォルダ内を自動検出
npx tazuna pack MyApp.sln -o for-ai.xml
npx tazuna pack Sub\Project.vbproj --stdout
```

入力を省略すると、カレントディレクトリ(ディレクトリ指定ならその直下)の
`*.sln` を自動検出します(なければ `*.vbproj`)。複数見つかった場合は
候補を表示して終了するので、対象を明示してください。設定ファイルに `target` があればそれを、
`kind: "generic"` があれば `.sln` / `.vbproj` を探さずに generic 構成でまとめます。

```text
オプション:
  -o, --output <file>     出力先(既定: ルートの repomix-output.xml)
      --root <dir>        ルートを明示する(入力はその配下にあること)
      --stdout            ファイルではなく標準出力へ書く(BOM なし)
      --include-designer  Designer 関連ファイル(*.Designer.vb 等)を原文のまま含める
      --include-designer-file <名前|パターン>
                          指定した Designer 関連ファイルだけ原文のまま含める
                          (複数指定可。* をワイルドカードに使える。ファイル名
                          または論理パスに全体一致)
      --no-ui-summary     Designer.vb からの UI サマリー生成を無効化
      --no-mask           認証情報の自動マスクを無効化
      --no-strict-mask    高エントロピー文字列の機械的マスクを無効化
      --no-gitignore      .gitignore / .repomixignore による除外を無効化
      --legacy-paths      <file path> を旧形式(プロジェクト名\論理パス)にする(廃止予定)
      --include-generated 生成コード(generatedDirs)の原文を含める
      --instruction-file <path>
                          出力末尾に連結する規約文ファイルを明示指定
                          (既定: 内蔵の規約文。ルートに protocol.md を置くとそれを使う)
      --no-instruction    規約文(<instruction>)を出さない
      --task <file|text>  依頼内容を出力末尾に <task> として同梱
                          (ファイルが存在すれば読み込み、なければ文字列)
      --mode <full|plan|implement|design>
                          作業手順のモード(既定: full。docs 連携時は文書の
                          状態から自動選択)
      --design <名前|file> design モードで対象の設計書を指定(なければ新規作成)
      --init-docs         docs/ 連携だけを設定する(tazuna init に含まれる)
      --init-config       VB.NET 以外のプロジェクト向けの tazuna.config.json
                          (kind: "generic")だけを作る(既にあれば変えない。
                          tazuna init に含まれる)
      --plan <file>       implement モードで承認済みの方針を <plan> として同梱
      --procedure-file <path>
                          作業手順文を明示指定(既定: ルートの procedure.md。
                          なければ内蔵既定文)
      --no-procedure      <procedure> を出さない(従来出力)
      --print-procedure   内蔵の作業手順文を標準出力に書いて終了
      --prompt-output <file>
                          本文用テキストの出力先(既定: パックと同じ場所の
                          <出力名>.prompt.md)
      --no-prompt         本文用テキストを書かない
      --print-prompt      本文用テキストを標準出力に書いて終了
      --no-clip           貼るもの(パック全体か本文用テキスト)をクリップボードに
                          入れない(下記「クリップボードへの自動コピー」)
```

## ファイルパスの規則(物理パス化)

`<file path="...">` は**ルート**からの相対物理パスで、`/` 区切りです。AI が
changes.md に書くパスをこの `path` と一致させることで、`npx tazuna` が
パス変換なしにそのまま適用できます。

ルートは次の順で決まります。パックと変更の適用で同じ決め方です(0.15.0〜。設定ファイル・
protocol.md・procedure.md・docs/・出力先の既定もルート基準):

1. `--root <dir>` の明示指定(入力はその配下にあること)
2. 入力のディレクトリから上に向かって最初に見つかる設定ファイル(`tazuna.config.json` /
   `slnmix.config.json`)の場所(`.git` のあるディレクトリより上には行かない)
3. 上に向かって最初に見つかる `.git` の場所(リポジトリの直下)
4. どれもなければ入力(`.sln` / `.vbproj`)のあるディレクトリ

web と dotnet を分けた構成(例: webview2-bridge の雛形は `dotnet/MyApp.sln`)でも、
アプリのルートの物理パス(`dotnet/MyApp.Impl/X.vb`)になり、変更を当てるときのルートと一致します。
以前の slnmix は設定ファイルが無いと `.sln` のある場所をルートにしていたため、設定ファイルの無いプロジェクトで
`.sln` がリポジトリ直下より下にあると、`<file path>` の先頭にフォルダ名が付くようになります。

```xml
<file path="App/Forms/OrderForm.vb">                                   ← 物理パス = 論理パス
<file path="Shared/Util.vb" project="App" logical="Common\Util.vb">    ← Link(論理パスと異なる)
<file path="Basic/Module1.vb" project="Basic" physical="D:/Src/Basic/Module1.vb" outside_root="true">
                                                                       ← ルート外(適用ツールの範囲外)
```

- `<directory_structure>` は従来どおり Visual Studio の論理ツリー(人が読む用)。
  物理パスが異なるファイルは行末に `→ 物理パス` を併記
- ルートの外にあるファイル(別ドライブの Link など)は論理パスを `path` にし、
  `physical` 属性に物理パスを付けて `<file_summary>` に「適用ツールの範囲外」と
  明記
- `<file_summary>` に規則を明記し、新規ファイルも同じ規則で「置きたい
  プロジェクトの物理フォルダ配下」に書くよう AI に指示
- v0.12.0 で既定を変更しました(後方互換を破る変更)。旧形式
  `プロジェクト名\論理パス` が必要な場合は `--legacy-paths` を指定してください
  (1〜2 バージョン残して廃止予定)

## ハイブリッド構成(`tazuna.config.json`)

WinForms + WebView2 + React([webview2-bridge](https://github.com/ishibashi0112/webview2-bridge))
のように `.vbproj` に乗らない web 側・契約側のディレクトリがある場合、ルート直下に
`tazuna.config.json`(旧名の `slnmix.config.json` のままでも読みます。両方あるとエラー)を置くと
同じパックに入ります。**なくても動きます**
(`tazuna init` は `target` と `docs` までを書きます。`extraRoots` は手で足してください。
`.sln` の無いプロジェクトは下記「VB.NET 以外のプロジェクト」)。

```jsonc
{
  // 引数なしの npx tazuna pack が使う入力(ルート相対)。.sln がサブディレクトリにあるときに書く
  "target": "dotnet/App.sln",
  "extraRoots": [
    { "path": "apps/web", "kind": "web" },
    { "path": "contract", "kind": "contract", "include": ["contract.ts", "package.json"] }
  ],
  // 以下は同じ場所に webview2-bridge.gen.json があれば自動検出(明示すれば上書き)
  "contractSchema": "contract/contract.schema.json",
  "generatedDirs": ["dotnet/App.Contract/Generated", "apps/web/src/generated"]
}
```

- `target`: 引数を省略した `npx tazuna pack`(またはディレクトリ指定)が使う入力。
  ルート相対で `.sln` / `.vbproj` を指す。設定ファイルのある場所がルートになるので、
  アプリのルートで `npx tazuna pack` と打つだけで済みます
- `extraRoots[].path`: ルート相対。**宣言されたディレクトリだけ**走査します
  (ディレクトリ走査をしない原則の、明示的でスコープの狭い例外)
- `include` の既定: `kind: web` は `**/*.{ts,tsx,js,jsx,css,json,html}`、
  `kind: contract` は `**/*.ts`、`kind: test` は `**/*.{ts,tsx,json,md}`、
  `kind: src` は `**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,json,html,md}`、
  それ以外は `**/*`。`exclude` で追加除外
- `kind: test`(例: `{ "path": "e2e", "kind": "test" }`)があるか、パックに
  `e2e/` 配下または `*.spec.ts` / `*.test.ts` のファイルが含まれると、手順文に
  「自動テスト」の節が入り、AI にテストの同梱を求めます(下記「作業手順の自動付与」)
- `include` に関わらず常に除外: `node_modules/`、`dist/`、`build/`、`.vite/`、
  `*.map`、`.env*`、`.gitignore` / `.repomixignore` に一致するもの、バイナリ拡張子
- 出力では `<directory_structure>` に `[web] apps/web/` のようにグループ表示し、
  `<file path="apps/web/src/App.tsx" root="web">` の `root` 属性で区別します
- **認証情報マスクは web 側にも同じように効きます**(厳格モードでは API キー
  らしき高エントロピー値も `[MASKED]`。`.ts` / `.js` などは文字列とコメントの中だけを伏せる)。`.env*` は既定で除外。VB 側で守っている
  安全性が web を足した瞬間に落ちないようにしています。ただし機械判定なので
  共有前の目視確認は引き続き推奨します
- `generatedDirs` 配下(webview2-bridge の生成コード)は既定で除外し、
  `contractSchema`(`contract.schema.json`)から生成した **`<contract_summary>`**
  (メソッド・イベント・DTO の一覧)で代替します。原文が必要なら
  `--include-generated`。スキーマの形式が未知(`contractVersion` が対応外)なら
  要約せず `<skipped_files>` に理由を書き、原文の `contract.ts` だけを出します

```xml
<contract_summary path="contract/contract.schema.json">
契約から生成された API の要約(生成コード dotnet/App.Contract/Generated/、apps/web/src/generated/ は除外。契約の正本は contract/contract.ts):
methods:
- parts.search(input: { keyword: string; limit?: integer }) -> { items: Part[] }
events:
- progress(payload: { percent: number; message?: string })
types:
- Part { partNo: string; name: string; qty: integer; updatedAt: string(ISO 8601) }
</contract_summary>
```

## VB.NET 以外のプロジェクト(`kind: "generic"`)

`.sln` / `.vbproj` の無いプロジェクト(TypeScript・Python・C#・Go など)でも、
同じパックと本文用テキスト(`.prompt.md`)が作れます。本家 repomix との違いは
**手順文・規約文をチャット本文に貼る形で出す**ことです。M365 Copilot Chat は
添付ファイル内の指示を無視するため、repomix の `instructionFilePath` で末尾に
埋めた規約文は届きません(下記「M365 Copilot Chat への渡し方」)。

```console
npx tazuna init          # 一回だけ。.sln / .vbproj が無ければ generic の設定を作る
npx tazuna pack          # repomix-output.xml と repomix-output.prompt.md ができる
```

git のリポジトリでは、`init`(と単独の `--init-config`)は `{ "kind": "generic" }` だけを書きます。
このとき対象は **git が管理しているファイル**(`git ls-files --cached --others --exclude-standard`。
コミット済みのものと、`.gitignore` に一致しない未コミットのもの)です(0.15.0〜)。一覧は
リポジトリが宣言したものなので、推測で対象を決めない方針に合います。次は除き、理由を `<skipped_files>` に残します。

- 既定の除外(`node_modules/`・`dist/`・`build/`・`.vite/`・`*.map`・`.env*`)と、`.gitignore` /
  `.repomixignore` に一致するもの(追跡中でも)
- バイナリ(拡張子と、中身に NUL を含むもの)・ロックファイル(`package-lock.json`・`pnpm-lock.yaml`・
  `poetry.lock`・`go.sum` など)・256KB を超えるもの
- `<docs>` / `<db_schema>` に入れる文書(重ねて入れない)

前回のパック(`repomix-output.xml` / `.prompt.md`、`-o` で変えた出力先)は `.gitignore` に書いていなくても入れません。

対象を絞りたいときは `.repomixignore` に除外を書くか、`extraRoots` にディレクトリを書きます。
`extraRoots` を書くと git の一覧は使わず、宣言したディレクトリだけを走査します(以前の slnmix と同じ)。
git のリポジトリでない場所では `extraRoots` が必要で、`init` は実在するディレクトリだけを書きます
(`src` / `app` / `lib` / `apps` / `packages` → `kind: "src"`、
`tests` / `test` / `e2e` / `__tests__` → `kind: "test"`)。候補が 1 つも無ければ
推測で書かずに設定例を表示して終わります。既に設定ファイルがあれば変えません。

```jsonc
{
  "kind": "generic",
  "extraRoots": [
    { "path": "src", "kind": "src" },
    { "path": "tests", "kind": "test" }
  ]
}
```

- `kind: "generic"` のときは引数なしの `npx tazuna pack` が `.sln` / `.vbproj` を探しません。
  ルートは設定ファイルの場所に固定で、`--root` / `--legacy-paths` / Designer 関連オプションは使えません
- `kind: "src"` の `include` 既定は `**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,json,html,md}`。
  他の言語で `extraRoots` を使うなら `include` を明示してください
- 認証情報の自動マスクは、TypeScript / JavaScript・Java・C#・Go・Python では言語の字句を読み、
  文字列・コメント・数値の中だけを伏せます(`const apiKey = process.env.API_KEY;` は伏せない)。
  1 行で閉じるはずの文字列が閉じていない行は、読み違えを避けるため行全体を文字列とみなします。
  それ以外の言語・設定ファイルは言語を区別せずに伏せます
- 出力ヘッダーから Visual Studio / Designer / `.resx` の記述が消え、手順文
  (`<procedure>`)も VB 固有の項目(`<ui_summary>`・`.vbproj`・`Option Strict`・
  `Handles` 句・Shift_JIS)を外した文面になります(先頭行に `layout: generic`)。
  VB.NET プロジェクトの出力は従来と同一です
- docs/ 連携(`--init-docs`)、`--task` / `--mode`、自動テストの節、変更の適用は
  そのまま使えます
- `.sln` / `.vbproj` を引数で明示したときは設定の `kind` に関わらず従来どおり
  論理構成で出力します(警告を表示)

## SDK スタイル .vbproj

`<Project Sdk="Microsoft.NET.Sdk">`(または `<Import Project="Sdk.props" Sdk="..." />`)
形式のプロジェクトは `Compile` を書かず、プロジェクトフォルダ配下の `**/*.vb` が
暗黙に含まれます。`tazuna pack` はこの既定グロブだけを展開します。

- 除外: `bin/**`、`obj/**`、`**/*.user`、ドットで始まるフォルダ、
  `<Compile Remove="...">`、`<DefaultItemExcludes>` の追加パターン
  (ワイルドカードは `**` / `*` / `?` のみ解釈)
- `<EnableDefaultCompileItems>false</EnableDefaultCompileItems>` なら展開しない
- 明示した `<Compile Include>` は従来どおり。`<Compile Update>` は一致する
  項目への `DependentUpon` / `SubType` 等のメタデータ付与として解釈
- `*.Designer.vb` の判定はファイル名規則で同様に行う(UI サマリーも同じ)
- 展開したことは `<file_summary>` に「MSBuild の完全評価ではない」と明記

旧スタイルと SDK スタイルが同じ `.sln` に混在していても、それぞれの形式で
扱います(WinForms + WebView2 のようなハイブリッド構成向け)。

## できないこと(仕様)

MSBuild の完全評価は行いません(静的 XML 解析のみ)。

- 旧スタイルの `$(Property)` / `@(Item)` / ワイルドカードを含む `Include` は
  展開せず、未解決として `<skipped_files>` に記載
- `Condition` は評価せず、条件付き項目としてそのまま含める
  (SDK スタイルの `EnableDefaultCompileItems` 等が `Condition` 付きなら、
  評価せず値を採用してその旨を診断に残す)
- `Import` された `.targets` / `.props` は展開しない
- SDK スタイルで `BaseOutputPath` / `BaseIntermediateOutputPath` を変更していても
  `bin` / `obj` の既定値で除外する。`Compile` 以外の既定グロブ
  (`EmbeddedResource` の `**/*.resx` 等)は展開しない(`.resx` は元々出力対象外)

推測で補完せず、解決できないものは解決できないと明記する方針です。

## M365 Copilot Chat への渡し方(添付 + 本文貼付)

実測(2026-09-12、設計書 §15.1)で分かった Copilot Chat の性質に合わせた推奨手順です。

| 経路 | 上限 | 指示の扱い | 本文の読まれ方 |
|---|---|---|---|
| 本文に貼る | 約 120K 文字(超えると送信ボタンが非活性) | ユーザー発話として**効く** | 全文がそのままコンテキストに入る |
| ファイル添付 | 事実上なし(800K でも可) | ファイル内の指示は「埋め込み指示」として**意図的に無視される** | 検索・部分読みで参照され、読み取り結果から**空行・行末空白が落ちる** |

パックが 120K 文字を超える(実務のソリューションではほぼ超えます)場合は、
**パックを添付し、手順文・規約文・依頼内容は本文に貼ってください。**
`tazuna pack` はそのための本文用テキストを、パックの隣に `<出力名>.prompt.md`
として既定で書き出します(`--no-prompt` で抑止、`--prompt-output <file>` で
出力先を変更、`--print-prompt` で標準出力へ)。

```console
npx tazuna pack --task task.md              # repomix-output.xml と repomix-output.prompt.md ができる
                                            # → 貼るものはクリップボードに入っている
```

`.prompt.md` の中身は、パック末尾に埋め込む `<task>` / `<plan>` / `<procedure>` /
`<instruction>` と一字一句同じです(正本は 1 つ)。先頭に「添付とこの本文の関係」を
述べる短い段落が付きます。

### クリップボードへの自動コピー

`npx tazuna pack` は実行の最後に、Copilot Chat に貼るものをクリップボードへ入れます。
`.prompt.md` を開いてコピーする手間がなくなります。

| パックの大きさ | クリップボードに入るもの | Copilot Chat でやること |
|---|---|---|
| 約 120K 文字以内 | パック全体(埋め込みの手順文・規約文を含む) | 本文に貼って送信。**添付は不要** |
| 約 120K 文字を超える | 本文用テキスト(`.prompt.md` と同じ) | `repomix-output.xml` を添付し、本文に貼って送信 |

どちらになったかは実行末尾の 1 行に出ます。小さいパックを本文に貼ると全文が
コンテキストに入り、埋め込みの指示も効くので、添付より確実です。
Windows は PowerShell の `Set-Clipboard`、macOS は `pbcopy`、Linux は `xclip`
(入っていれば)を使います。コピーできなかったときは警告を出し、従来の案内
(`.prompt.md` を開いて貼る)に戻ります。`--no-clip` で無効化、`--stdout` のときは
コピーしません。

添付経路では空行・行末空白が読み取りで失われるため、AI が出す SEARCH ブロックから
空行が抜けることがあります。変更の適用(`npx tazuna`)は空行の差を無視して照合するので、
そのまま適用できます。

## ビルドエラーの受け渡し(`tazuna build`)

```console
npx tazuna build                    # 対象の .sln / .vbproj を MSBuild でビルド
npx tazuna build --configuration Release
npx tazuna build --msbuild "C:\path\to\MSBuild.exe"
```

失敗すると、エラーごとに**今の実ファイルの周辺行**を付けた文面をクリップボードに入れます
(`--no-clip` なら標準出力)。Copilot Chat の本文に貼れば、AI は最新の内容から修正の
changes.md を書けます(パックを作った後に変更の適用で書き換わった行でも、SEARCH が
食い違いません)。成功したときは何も入れません。

- 対象の決め方とルートは `npx tazuna pack` と同じ(設定ファイルの `target` も使う)。
  `kind: "generic"` の構成では使えません
- MSBuild は vswhere(VS 2017 以降・Build Tools)> VS 2015 / 2013 の MSBuild >
  .NET Framework 4 の MSBuild の順に探します。Windows 以外では `--msbuild` が必要です
- エラーは MSBuild のファイルロガー(エラーのみ・UTF-8)から取り出すので、コンソールの
  文字コードに左右されません。載せるのは先頭 20 件までです
- 抜粋・エラーの本文・ログの末尾は、パックと同じ規則で認証情報を `[MASKED]` に伏せます
  (`--no-mask` / `--no-strict-mask` はパックと同じ)。`.gitignore` /
  `.repomixignore` でパックから除外しているファイルは、抜粋を載せません(`--no-gitignore` で載せる)
- `build` という名前のフォルダを入力にするときは `./build` と書いてください

## 規約文(`<instruction>`)

AI に changes.md の書き方を守らせるための規約文を、出力末尾に `<instruction>` ブロックとして付けます。
規約文は tazuna に内蔵されていて(`npx tazuna protocol` で表示)、tazuna を更新すれば最新の版になります
(以前のように `init` を打ち直す必要はありません)。規約文を付けたときは、出力の先頭にも末尾の規約へ
誘導する短いリマインダを置きます。**ただし Copilot Chat にファイル添付で渡す場合、添付内の規約文は
無視されます。** 規約文は本文用テキスト(`<出力名>.prompt.md`、上記)にも含まれるので、添付で渡すときは
そちらを本文に貼ってください。

- ルートに `protocol.md` を置くと、その内容を一字一句そのまま使います(内蔵の規約文の上書き)。
  `npx tazuna protocol > protocol.md` で書き出して編集してください。内蔵より古い版を元にした上書きは警告します
- 以前の `slnmix init` / `petari init` が書いた `protocol.md` に手を加えていなければ(過去の版と一字一句同じなら)、
  使わずに内蔵の最新版を使い、削除してかまわないと 1 行表示します
- 別の場所・別名のファイルを使う場合は `--instruction-file <path>`、規約文を付けない場合は `--no-instruction`

## 作業手順の自動付与(`<procedure>` / `--task` / `--mode`)

M365 Copilot のように思考量を外から制御できないチャットでは、
**回答の中で考えさせる**方が確実です。`tazuna pack` は既定で、出力末尾に
「調査 → 方針 → 変更 → 自己検証」の手順を `<procedure>` ブロックとして同梱し、
曖昧なら推測せず質問して止まるよう指示します。先頭にはタスクの 1 行要約と
末尾ブロックへの誘導(リマインダ)を置きます。

規約文(`<instruction>`)が「changes.md の**書き方**」の規約なのに対し、
`<procedure>` は「変更を考える**手順**」です。責務が違うので別ブロックにしています。
`<procedure>` は既定で付きます(`--no-procedure` で
従来どおりの出力に戻ります)。添付で渡す場合は本文用テキスト(上記)側の
`<procedure>` が効きます。

```console
npx tazuna pack --task "受注フォームに保存ボタンを追加する"   # 依頼内容を <task> に同梱
npx tazuna pack --task task.md                                # ファイルなら読み込む
```

### モード(`--mode`)

| モード | 用途 | AI に要求する回答の構成 |
|---|---|---|
| `full`(既定) | 小〜中規模の変更を 1 ターンで | 調査 / 方針 / 変更(changes.md)/ 自己検証 |
| `plan` | 方針を先に固める | 調査 / 方針 / 質問(changes.md は出させない) |
| `implement` | 承認済みの方針で実装 | 方針の確認 / 変更(changes.md)/ 自己検証 |
| `design` | 設計書を質疑応答で仕上げる(docs 連携が必要) | 調査 / 設計書(changes.md)/ 確認事項 / 継続判定 |

大きめの変更は `plan` → `implement` の 2 ターンに分けると、回答の出力上限で
changes.md が途中で切れるのを避けられます。`plan` の回答を手直しして
ファイルに保存し、`implement` で `--plan` に渡してください(`implement` では
`--plan` が必須です)。

```console
npx tazuna pack --task task.md --mode plan                    # → 方針と質問だけが返る
npx tazuna pack --task task.md --mode implement --plan plan.md   # 承認した方針を <plan> として同梱
```

### 自動テストがあるプロジェクト

パックに `e2e/` 配下または `*.spec.ts` / `*.test.ts` のファイルがあるか、
設定ファイルの `extraRoots` に `kind: "test"` があると、手順文の末尾に
「自動テスト」の節が入ります(標準エラーに「自動テスト: あり(理由)」と出ます)。
AI は変更した振る舞いに対応するテストを同じ changes.md に含め、観点は仕様書・設計書の
決まった章(入力項目・操作一覧・処理フロー・業務ルール・エラー時)から読み取り、
画面に足した要素には `data-testid` を付けます。テストの置き場は `e2e/screen/`(DB なし)・
`e2e/api/`(契約メソッドと DB)・`e2e/host/`(画面から DB まで)の 3 層です
(仕組みは [HANDOFF-testing-2026-09.md](HANDOFF-testing-2026-09.md))。
**テストが無いプロジェクトでは手順文は従来と同一**で、AI にテストは求めません。

### テスト用 DB の値と動作を確かめる

ルートに `docs/db/schema.md`(テスト用 DB のテーブル定義)があると、パックに
`<db_schema>` として入れ、手順文の末尾に「DB の確認」の節を入れます(標準エラーに
「DB の確認・動作検証: あり」と出ます)。AI は DB の値が答えを左右するとき、推測せずに確認用の
SELECT を `checks/<名前>.sql` として changes.md で出し、回答の末尾に実行コマンドを書きます。
**tazuna は DB に接続しません。** テーブル定義の書き出しと SELECT の実行は別ツールの
[ashiato](https://github.com/ishibashi0112/ashiato) が行います。

```console
npx ashiato schema --tables "受注*,顧客"     # 一回だけ: docs/db/schema.md を書く(行の値は含まない)
npx ashiato query checks/受注合計.sql        # AI が書いた SELECT を実行し、結果をクリップボードへ
```

ashiato は `npm install -g ashiato mssql oracledb` のように、使う DB のドライバーと一緒に
グローバルに入れておきます(アプリのルートで `npx ashiato` がそのまま動きます)。
`ashiato query` が実行するのは SELECT / WITH だけで、書き込みやロックの語が 1 文でもあると
1 文も実行しません。接続には SELECT だけを許可したユーザーを使い、結果(DB の値)を
チャットに貼ってよいかは社内の決まりに従ってください(流れは
[WORKFLOW.md](WORKFLOW.md) の 3-8)。

同じ条件で、手順文に「動作検証」の節も入ります。AI は画面やバッチの操作で
DB がどう変わるべきかを確かめるとき、操作の手順と期待する変化を `checks/<名前>.verify.md`
として出します。`npx ashiato verify checks/<名前>.verify.md`(ashiato 0.2.0〜)を打つと、
手順が 1 つずつ表示され、アプリで操作して Enter を押すたびに DB の変化を期待と照合します。
最後に OK / NG・違い・変わった行がクリップボードに入るので、チャットに貼ります
(流れは [WORKFLOW.md](WORKFLOW.md) の 3-9)。

```markdown
## 1. 受注を登録する
受注画面で得意先 C001・品目 A001・数量 3 を入れて「登録」を押す

期待する DB の変化:
- 受注: 追加 1 行 (得意先コード=C001, 状態=10)
- 在庫: 更新 1 行 (品目コード=A001) → (在庫数-=3, 更新日時=*)
```

### 手順文のカスタマイズ(`procedure.md`)

ルートに `procedure.md` があれば、内蔵既定文の代わりにその内容を
一字一句そのまま使います(`{{MODE}}` / `{{MODE_SECTIONS}}` があればモードに
応じて置換)。生成コマンドはありません。内蔵既定文を書き出して編集してください。

```console
npx tazuna pack --print-procedure > procedure.md         # 内蔵既定文を書き出す
npx tazuna pack --print-procedure --mode plan            # モード別の文面を確認
```

プロジェクト固有のルール(コーディング規約・禁止事項など)は
`procedure.md` の末尾に追記する運用を想定しています。別ファイルは増やしません。
書き出した文面の末尾にある `{{DOCS_SECTIONS}}` は残しておくと、docs 連携(下記)が
有効なときに「文書の扱い」「チャットの継続と引継ぎ」の 2 節に置換されます。同じく
`{{TEST_SECTIONS}}` は自動テストがあるとき(上記)に「自動テスト」の節に、
`{{DB_SECTIONS}}` は `docs/db/schema.md` があるとき(上記)に「DB の確認」の節に置換されます。
`kind: "generic"` の場所で `--print-procedure` を実行すると、VB 固有の項目を外した
generic 向けの文面が書き出されます(`{{LAYOUT:...}}` は置換済み)。

## プロジェクト文書の連携(`docs/` — 設計書・仕様書・引継ぎ書)

日々の手順(新規開発の始め方・実装の続け方・既存プロジェクトの乗せ替え・
継続判定への対応・コマンド早見表)は
[WORKFLOW.md](WORKFLOW.md) にまとめています。迷ったらそちらを開いてください。

設計書や引継ぎ書を毎回チャットに添付する代わりに、プロジェクトの `docs/` に置いて
`tazuna pack` に読ませます。文書の状態から作業モードが自動で決まり、文書の作成・更新も
AI が changes.md で出して `npx tazuna` が保存するので、日常のコマンドは
`npx tazuna pack` と `npx tazuna` の 2 つだけになります。

```console
npx tazuna init           # 一回だけ: docs/design/ docs/spec/ docs/README.md を作り
                          #           設定ファイルに "docs" を追記する
                          #           (docs だけなら npx tazuna pack --init-docs)
npx tazuna pack           # 以後はこれだけ。モードとタスクは文書の状態から自動
npx tazuna                # AI の changes.md(コードも文書も)を適用する
                          # (npx tazuna watch を起動しておくと、届くたびに自動で適用)
```

| 文書 | 場所 | 役割 | 更新のタイミング |
|---|---|---|---|
| 設計書 | `docs/design/<名前>.md` | 開発の進め方と判断の根拠。1 行目の状態行で draft / ready | 設計の質疑応答ごと(AI が replace)。必須の確認事項がゼロで ready |
| 仕様書 | `docs/spec/<名前>.md` | 実装済みの振る舞いの正本(誰が読んでも分かる書き方) | 設計確定時に初版、各バッチの完了時 |
| 引継ぎ書 | `docs/HANDOFF.md` | チャット間の申し送りだけ(1 ファイル固定。履歴は git) | チャットを切り替えるとき(AI が rewrite) |

### 設計から実装への流れ(モードの自動選択)

| `docs/` の状態 | モード | 本文用テキストに載る文書 | 既定の依頼内容(`--task` 省略時) |
|---|---|---|---|
| 設計書なし | `design`(新規) | なし | 新しい設計書を作成する |
| 設計書が draft | `design`(継続) | その設計書 | 質疑応答で仕上げる(必須 N / 後回し M が未回答) |
| 設計書が ready、引継ぎ書なし | `full` | なし | 最初の未完了バッチを実装 |
| 設計書が ready、引継ぎ書あり | `full` | 引継ぎ書 | 引継ぎ書の「次にやること」を進める |

設計書の状態は 1 行目の状態行で管理します(AI が確認事項の件数と一致するように保ちます)。

```
<!-- slnmix design: status=draft blocking=2 deferred=3 -->
```

確認事項は 2 種類です。**必須**(`blocking`)は回答がないと実装に進めないもの、
**後回し**(`deferred`)は実装を進めながら確認期限(どのバッチの着手前か)までに
回答すればよいもの。必須がゼロになれば後回しが残っていても `ready` になり実装に
進めます。実装中は、バッチ着手前に期限の来た後回しがないかを AI が確認します。
状態行のない設計書(旧形式)は警告のうえ ready 扱いです。

- 仕様書や引継ぎ書がまだなければ、パックと本文用テキストの `<docs>` にその旨と
  「最初の回答で初版を create する」指示が入り、既定の依頼文にも先頭に足されます
  (設計書が済んで実装途中の既存プロジェクトを、設計書と引継ぎ書を置くだけで
  乗せ替えられます)。文書が何もない完成済みプロジェクトの改修では、AI が先に
  改修対象の画面・機能に限った現状の仕様書をコードから起こし、それを参照する
  設計書を書きます
- draft の設計書が複数あるときは `--design <名前>` で対象を指定します。存在しない
  名前なら `docs/design/<名前>.md` を新規作成する design モードになります
- `--mode full|plan|implement` を明示すれば自動選択より優先します
- パックの `<docs>` には全文書が入り(添付側。検索で参照)、本文用テキストには
  「今編集される文書」だけが入ります(design モードは設計書、他は引継ぎ書)。
  設計書 64K 文字でも本文用テキストは約 80K で貼付上限内です
- 本文用テキストには文書の**ひな型** `<templates>` も載ります(設計書 / 仕様書 /
  引継ぎ書。Mermaid のフロー・状態遷移・ER を章立てに含む)。差し替えたい場合は
  `docs/templates/<design|spec|handoff>.md` を置きます

### チャットの切り替え(引継ぎ)

AI は自分のコンテキスト残量を測れないので、手順文は会話の中で数えられる引き金で
判断させます。毎回の回答末尾に「継続判定」が付きます。

- **引継ぎ(自動)**: 実装バッチが完了し、あなたがビルドと動作確認の成功を伝えると、
  AI は同意を待たずにその回答で仕様書の更新と `docs/HANDOFF.md` の書き直し
  (コード変更とは別の changes.md)を出し、「`npx tazuna` → `npx tazuna pack` → 新しい
  チャットへ」と案内します。「1 バッチ = 1 チャット」が既定の動きです。
  続けたいときは「このチャットで続ける」と伝えます
- **引継ぎ推奨(同意待ち)**: ①changes.md を 3 回以上出した(エラー修正のやり直しを
  含む)②tazuna の失敗レポートを 2 回受けた ③パックを添付し直した、のいずれかで
  理由を添えて勧め、返事を待ちます。同じエラーに 2 回以上失敗しているときは、失敗した
  試行が残るチャットより、修正途中のコードを含む最新のパックで始め直す方が早いためです
- バッチの途中で引き継ぐときは、引継ぎ書に「着手中」「未解決のエラー」「試して効かな
  かった修正」「まだ試していない案」が入り、次のチャットが同じ試行を繰り返しません

## 関連プロジェクト

- [ashiato](https://github.com/ishibashi0112/ashiato) — テスト用 DB のテーブル定義の書き出し・確認用の
  SELECT の実行・操作の前後の DB の変化の照合(DB の資格情報とドライバーを扱うため、tazuna とは別のツール)
- [Legacy VB.NET Workbench](https://github.com/ishibashi0112/legacy_vb_workbench)
  — VS Code 上で同じ論理ツリーを表示・ビルド・エクスポートする拡張。
  解析コアは元々共通でしたが、現在は tazuna の `src/pack/` が唯一の置き場で、拡張は
  2026-09 時点で凍結しています
