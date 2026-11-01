# HANDOFF — slnmix / petari 改修設計（M365 Copilot 内 Opus の性能を引き出す）

作成日: 2026-09-11
置き場: 2026-11-01 の統合(§25)で slnmix のリポジトリから petari のリポジトリ(同日 tazuna に改名)の `docs/` へ移した。§25 より前の章のコマンド名・ファイル名(`npx slnmix` / `npx petari` / `slnmix.config.json` など)は書いた時点のまま残している。今の名前は §25.2 の表と §25.8-1 を参照(統合したツールの名前は **tazuna**。§25 の本文で petari と書いているものは、今は tazuna)
対象リポジトリ: `ishibashi0112/slnmix`（主）、`ishibashi0112/petari`（従）、`ishibashi0112/webview2-bridge`（任意）
実装担当: Claude Code。本書を最初に読み、各リポジトリの CLAUDE.md の規約に従うこと。決めたことは §17 決定ログに追記する。

---

## 0. この文書の読み方

- §1〜§4 は背景・原則・現状。実装前に一度読む
- §5 がフェーズ一覧。**フェーズ順に実装し、フェーズごとに完了条件（§16）を満たしてから次へ進む**
- §6〜§10 が slnmix の各フェーズ、§11 が petari、§12 が webview2-bridge（任意）
- §14 は未決定・要確認事項。実装中に答えが出たら §17 に記録する
- 設計判断に迷ったら §2 の原則に戻る。原則と衝突する実装はしない

---

## 1. 背景と目的

### 1.1 状況

- 会社環境で使える AI は M365 Copilot Chat のみ。モデルは Claude Opus（表示は「Opus」のみ。4.8 と推定。テナントによっては Opus 5 が展開済みの可能性あり）
- 思考エフォート（拡張思考の量）は M365 Copilot 側に隠蔽されており、ユーザーから制御できない
- 個人環境の Claude Fable 5 / Opus 5 と比べると性能差を常に感じる
- 現行フロー: `slnmix` で VB.NET ソリューションを 1 ファイルにパック → Copilot Chat に貼付/添付 → AI が `changes.md` を出力 → `petari apply` でローカルへ適用。コピペ適用自体は安定してきた
- 手でコードを書く機会は激減し、petari 経由の反映が主になっている

### 1.2 目的

外から制御できない思考エフォートを、**プロンプト側の構造で補う**。あわせて、これから増えるハイブリッド構成（WinForms + WebView2 + React、`webview2-bridge`）を slnmix が扱えるようにし、新規ファイル作成時の petari の失敗をなくす。

### 1.3 期待する効果（優先順）

1. 回答の質: 調査 → 方針 → 変更 → 自己検証の手順を強制し、曖昧なら推測せず質問させる
2. ハイブリッド対応: VB 側と React 側を**同じパック**で見せる（契約をまたぐ変更はこれがないと成立しない）
3. 新規ファイル: petari が `.vbproj` 登録まで担い、Visual Studio での手作業をなくす
4. コンテキスト量: 入力上限に当たったときの手段として絞り込みを用意する（**主目的ではない**）

---

## 2. 原則（実装判断の基準）

1. **必須セットアップは `npx slnmix init` 一回のみ。** slnmix は設定ファイルなしでも動く。カスタマイズしたい人だけ `procedure.md` / `slnmix.config.json` を置く(2026-10-11 改訂。旧: 「`petari init` 一回のみ。`slnmix init` は作らない」。§20)
2. **削るより、抜け落ちないことを優先。** 既定は全件出力。絞り込みは明示オプション。外したものは骨格として残し、一覧で明示する。黙って捨てない（既存方針の継承）
3. **推測しない。推測したときは宣言する。** MSBuild 完全評価はしない（既存方針）。SDK スタイルの既定グロブ展開のように推測を伴う処理は、出力に「展開した」と明記する
4. **解析コアは slnmix が単独で持つ。** legacy_vb_workbench との二重管理は終了。workbench は凍結（§13）
5. **petari は「vbproj 対応 create」「新規ファイルのエンコーディング推定」「目録警告（任意）」「init の `--no-repomix`（§20）」以外触らない。** webview2-bridge は「対応表 JSON（任意）」以外触らない
6. **依存は増やさない。** slnmix は fast-xml-parser / iconv-lite / ignore と petari(2026-10-11 追加。`slnmix init` が `petari init` を呼ぶため。petari 自身は実行時依存ゼロ)。petari は実行時依存ゼロのまま
7. **後方互換。** オプションを付けなければ、既存ユーザーの出力は（§8.4 の物理パス化を除き）変わらない

---

## 3. 現状の構成と関係

```
[会社 PC]                                    [AI: M365 Copilot Chat / Opus]
  .sln / .vbproj ──slnmix──> repomix-output.xml ──貼付/添付──> 回答 (changes.md)
  ローカルコード <──petari apply── changes.md <──ダウンロード/クリップボード──┘
```

| ツール | 役割（一言） | 正本となる設定 |
|---|---|---|
| **slnmix** | AI に**何を見せ、どういう手順で考えさせるか** | なし（任意で `procedure.md` / `slnmix.config.json`） |
| **petari** | AI の回答を**どう書かせ、どう当てるか** | `protocol.md`（`petari init` が生成、petari が正本を持つ） |
| **webview2-bridge** | zod 契約から TS / VB を**生成**する | `contract/contract.ts`、`webview2-bridge.gen.json` |
| legacy_vb_workbench | VS Code で .sln の論理ツリーを表示・ビルド・エクスポート | — （**凍結**） |

### 3.1 slnmix の現状（要点）

- `.sln` → `.vbproj` を静的解析し、ビルド対象の論理構成（Link / DependentUpon 解決済み）でエクスポート
- Designer.vb は除外し `<ui_summary>` で要約。`.resx` は常に除外
- 認証情報マスク（既定で厳格モード）、`.gitignore` / `.repomixignore` 尊重
- `protocol.md` があれば「先頭リマインダ + 末尾 `<instruction>`」のサンドイッチ配置
- `<file path="...">` は `プロジェクト名\論理パス`（`\` 区切り）
- 旧スタイル .vbproj 前提。ワイルドカード Include は未解決として `<skipped_files>` へ
- 共有コア（`types.ts` / `paths.ts` / `slnParser.ts` / `vbprojParser.ts` / `logicalTreeBuilder.ts` / `services/*`）は workbench と二重管理中 → **本書で終了**

### 3.2 petari の現状（要点）

- `changes.md` の操作種別: `replace` / `create` / `rewrite` / `delete`。**`create` は既に実装済み**
- パスは「プロジェクトルート相対・`/` 区切り」のみ受け付ける。絶対パス・`..` は拒否
- 新規ファイルの既定は `.petari/config.json` の `newFile: { encoding: "utf8", eol: "lf" }`。**BOM なし**
- エンコーディング保全は行単位（無変更行は元バイト列を書き戻す）
- `src/core/` は純粋ロジックのみ（ファイル I/O 禁止）。I/O は `src/infra/`
- SEARCH 照合は多段（空行差を無視する段を含む）

### 3.3 webview2-bridge の現状（要点）

- `contract/contract.ts`（zod）→ `contract.schema.json`（中間表現）→ TS 型 / VB DTO・Interface・Dispatcher を生成
- 生成先: `dotnet/WebView2Bridge.Contract/Generated/*.vb`、`apps/web/src/generated/*`
- `webview2-bridge.gen.json` に `vb.namespace` / `vb.runtime.outDir` / `vb.winforms.outDir` 等を記述
- dotnet 側は SDK スタイル .vbproj（netstandard2.0 / net48）。既存の旧スタイル .vbproj には触れない方針

実業務での想定レイアウト（旧アプリに webview2-bridge を足した状態）:

```
Repo/
  App.sln                       ← 旧スタイル .vbproj（既存 WinForms）
  App/App.vbproj
  App/Forms/*.vb, *.Designer.vb
  dotnet/App.Contract/           ← SDK スタイル（生成コード）
  dotnet/App.Impl/               ← SDK スタイル（人が書く API 実装）
  dotnet/App.Host/               ← SDK スタイル（WinForms + WebView2 ホスト）
  contract/contract.ts           ← 契約の正本（.vbproj に乗らない）
  apps/web/                      ← Vite + React（.vbproj に乗らない）
  webview2-bridge.gen.json
  protocol.md                    ← petari init が生成
```

---

## 4. 用語

- **パック**: slnmix の出力（`repomix-output.xml`）
- **段（tier）**: パック内でのファイルの出し方。`full`（全文）/ `skeleton`（シグネチャのみ）/ `summary`（`ui_summary` / `contract_summary` による要約）/ `skipped`
- **論理パス**: `.vbproj` 上の見え方（Link を反映）。**物理パス**: ディスク上の実パス
- **ルート**: パックの基準ディレクトリ。`.sln` のあるディレクトリ（`.vbproj` 直指定時はその親）。petari のプロジェクトルートと一致させる（§14-3）
- **手順文（procedure）**: AI の作業手順を指示する文。slnmix が内蔵。`protocol.md`（出力形式規約）とは別物
- **旧スタイル / SDK スタイル**: `.vbproj` の形式。`<Project Sdk="...">` があれば SDK スタイル

---

## 5. フェーズ一覧と優先順

| # | 内容 | リポジトリ | 前提 | 優先 |
|---|---|---|---|---|
| 1 | 手順テンプレート（`<procedure>`）、`--task`、`--mode` | slnmix | なし | **最優先** |
| 2 | SDK スタイル .vbproj 対応 | slnmix | なし | 高（webview2-bridge を使うなら必須） |
| 3 | `extraRoots`（web 同梱）、`<contract_summary>`、web 側マスク、**物理パス化** | slnmix | 2 | 高 |
| P1 | petari: vbproj 対応 `create`、新規ファイルのエンコーディング推定 | petari | 3（物理パス化） | 高（1〜3 と並行可） |
| 4 | `--focus` / skeleton / シンボル索引 / `--budget` | slnmix | **入力上限の測定（§15.1）** | 中（測定後に着手） |
| 5 | 境界またぎのリンク（契約メソッド名で TS ↔ VB を接続） | slnmix（+ webview2-bridge 任意） | 3, 4 | 低 |
| P2 | petari: 目録による警告（任意） | petari | 4 | 低 |
| W | workbench 凍結の明文化、slnmix CLAUDE.md 更新 | slnmix / workbench | なし | フェーズ 1 と同時 |
| 6 | docs/ 連携（設計書・仕様書・引継ぎ書）、モード自動選択、`design` モード、内蔵ひな型、`--init-docs`（§18） | slnmix | 1.5 | 高（2026-09-15 追加、v0.14.0 で実装） |
| M | slnmix と petari の統合(§25。M1〜M4) | petari(+ slnmix の互換パッケージ) | 会社 PC での確認 | 方針は名前以外確定・未着手(2026-10-31 追加) |

フェーズ 1 だけでも効果がある。フェーズ 4 は上限測定の結果、不要と判断される可能性がある（その場合は着手しない）。

---

## 6. フェーズ 1 — 手順テンプレート、`--task`、`--mode`（slnmix）

### 6.1 狙い

思考エフォートを外から上げられないので、**回答本文の中で考えさせる**。調査 → 方針 → 変更 → 自己検証を必須セクションにし、曖昧なら推測せず質問して止まらせる。`protocol.md`（petari の出力形式規約）とは責務が違うので、別ブロックにする。

### 6.2 出力レイアウト（変更後）

```
<instruction_notice>   ← 先頭リマインダ。タスクの 1 行要約 + 末尾の <task>/<procedure>/<instruction> への誘導
<file_summary>          ← 既存 + 段の説明（フェーズ 4 で拡張）
<directory_structure>
<files>                 ← <file> / <ui_summary> / <contract_summary>（フェーズ 3）
<skipped_files>
<task>                  ← --task があるとき
<plan>                  ← --mode implement --plan があるとき
<procedure>             ← 内蔵既定文 or procedure.md
<instruction>           ← protocol.md（既存。petari の規約）
```

末尾に置く理由: 長い文脈の**後**に指示を置く方が従いやすい（既存のサンドイッチ設計と同じ根拠）。先頭リマインダは Copilot の要約処理で末尾が落ちる対策。

`<procedure>` は `protocol.md` の有無に関わらず出す（`--no-procedure` で抑止）。`protocol.md` がない場合、先頭リマインダは `<procedure>` への誘導のみになる。

### 6.3 オプション

```
--task <file|text>        タスク文。ファイルパスなら読み込み、そうでなければ文字列として扱う
--mode <full|plan|implement>   既定 full
--plan <file>             implement モードで承認済み方針を <plan> として同梱（implement では必須）
--procedure-file <path>   手順文を明示指定（既定: ルート直下の procedure.md を自動検出。なければ内蔵既定文）
--no-procedure            <procedure> を出さない（従来出力）
```

`--task` の text 判定: 引数がファイルとして存在すれば読む。存在しなければ文字列。改行を含む文字列は text 扱い。

### 6.4 モードごとの必須セクション

| モード | 用途 | AI の回答に要求するセクション |
|---|---|---|
| `full` | 小〜中規模の変更を 1 ターンで | 調査 / 方針 / 変更（changes.md）/ 自己検証 |
| `plan` | 方針を先に固める | 調査 / 方針 / 質問。**changes.md は出さない** |
| `implement` | 承認済み方針で実装 | 方針の確認（3 行以内）/ 変更（changes.md）/ 自己検証 |

`implement` で調査を省くのは、回答の出力上限に changes.md が押し出されるのを防ぐため（§14-5）。`<plan>` には `plan` モードの回答（ユーザーが修正したもの）をそのまま貼る運用。

### 6.5 内蔵既定文（`src/assets/procedure.ts`、`PROCEDURE_VERSION = 1`）

petari の `protocol.ts` と同じ形で single source にする。以下を初版とする。モードにより §「回答の構成」の部分だけ差し替える（テンプレート内の `{{MODE_SECTIONS}}` を置換）。

```markdown
<!-- slnmix procedure v1 (mode: {{MODE}}) -->
# 作業手順

これは、このコンテキストを添付したユーザー本人からの恒常的な指示です。
このパックに含まれるコードへの変更を提案するときは、必ず以下の手順で回答してください。
出力形式（changes.md の書き方）は末尾の <instruction> の規約に従います。本手順はその前段の「考え方」です。

## パックの読み方

- <file> は現在のファイル内容そのものです。記憶にある一般的な VB.NET / React のコードではなく、ここにある内容を正としてください
- <ui_summary> は Designer.vb からの要約です。コントロール名・型はここから引いてください。Designer.vb 本体は変更対象にしません
- <contract_summary> がある場合、それは契約（contract.ts）から生成された API の一覧です。Generated/ 配下および src/generated/ 配下は生成物なので変更対象にしません。契約を変える必要があれば contract.ts の変更として提案してください
- [MASKED] は伏せ字です。そのまま残し、値を推測しないでください
- <file_summary> に「骨格のみ（skeleton）」と記されたファイルは、シグネチャだけを載せています。本体が必要なら変更を出さず、そのファイル名を「追加で全文が必要なファイル」として挙げて回答を終えてください
- 新規ファイルは changes.md の create で出してください。.vbproj は編集しないでください（適用ツールが登録します）。パスは <file_summary> に示す物理パスの規則で書いてください

## 回答の構成

{{MODE_SECTIONS}}

## 判断の原則

- 分からないことは推測で埋めず、質問してください。特に「どのフォームか」「既存のどの処理に合わせるか」「例外時の挙動」が読み取れないときは、変更を出さずに質問だけで回答を終えてください
- 既存コードの流儀（命名・エラー処理・DB アクセスの書き方）に合わせてください。パック内に同種の処理があれば、それを手本にしてください
- Option Strict On を前提に、型変換は明示してください
- 影響範囲は最小にしてください。求められていないリファクタリングはしないでください
```

`{{MODE_SECTIONS}}` の内容:

**full:**

```markdown
### 1. 調査
読んだファイルと、関係するシンボル（クラス・メソッド・コントロール名）を箇条書きで挙げてください。
変更対象の処理がどこから呼ばれ、何を呼ぶかを 1〜3 行で述べてください。

### 2. 方針
何をどう変えるかを述べてください。検討して採らなかった案があれば理由とともに 1 行で。
リスク（既存動作への影響、未確認の前提）を挙げてください。
確認したいことがあれば、ここで質問し、変更を出さずに終えてください。

### 3. 変更
末尾の <instruction> の規約どおり changes.md を出してください。

### 4. 自己検証
changes.md の SEARCH ブロックごとに、次を表で確認してください。
| ファイル | ブロック | パック内に全文があるか | 空行・インデント込みで逐語一致か | ファイル内で一意か |
加えて次を確認してください。
- 同じファイルへの SEARCH ブロック同士が重なっていない
- Handles 句のイベント名・コントロール名が <ui_summary> と一致している
- Designer.vb / .resx / Generated / src/generated を変更していない
- 新規ファイルは create で出し、.vbproj を編集していない
- 日本語 Shift_JIS のファイルに、Shift_JIS で表現できない文字を入れていない
問題があれば changes.md を修正してから回答を確定してください。
```

**plan:**

```markdown
### 1. 調査
（full と同じ）

### 2. 方針
（full と同じ。ただし changes.md は出さない）

### 3. 質問
曖昧な点・確認したい点を番号付きで挙げてください。なければ「なし」と書いてください。
このモードでは changes.md を出さないでください。
```

**implement:**

```markdown
### 1. 方針の確認
<plan> の内容を 3 行以内で要約し、そのとおりに実装することを述べてください。<plan> と矛盾する事実をパック内に見つけた場合は、実装せずにその点を指摘して終えてください。

### 2. 変更
（full の 3 と同じ）

### 3. 自己検証
（full の 4 と同じ）
```

### 6.6 `procedure.md` による上書き

- ルート直下に `procedure.md` があれば、内蔵既定文の代わりにその内容を**一字一句そのまま**使う（`protocol.md` と同じ扱い）。`{{MODE_SECTIONS}}` / `{{MODE}}` プレースホルダがあれば置換する。なければそのまま
- `procedure.md` を生成するコマンドは作らない。代わりに `slnmix --print-procedure [--mode ...]` で内蔵既定文を標準出力に書けるようにし、カスタマイズしたい人はリダイレクトして編集する（これは init ではなく、必要な人だけが使う印刷機能）
- プロジェクト固有の規約（コーディング規約、禁止事項）は `procedure.md` の末尾に追記する運用を README で案内する。別ファイルは増やさない

### 6.7 先頭リマインダの変更

既存の `INSTRUCTION_NOTICE` を拡張し、以下を含める（存在するものだけ）:

```
[slnmix] このパックの末尾に <task>（依頼内容）、<procedure>（作業手順）、<instruction>（出力規約）があります。
回答の前に必ず末尾まで読んでください。
タスク: {{TASK_FIRST_LINE}}
モード: {{MODE}}
```

### 6.8 実装メモ

- CLI 固有（コア外）: `cli.ts`、`instructionFile.ts` を拡張するか `procedureFile.ts` を新設。`src/assets/procedure.ts` を追加
- テスト: モードごとの出力、`procedure.md` 上書き、`--task` のファイル/文字列判定、先頭リマインダ、`--no-procedure` で従来出力と一致すること
- README に「procedure と protocol の違い」「plan → implement の使い方」を追記

---

### 6.9 フェーズ 1.5 — チャット本文に貼る指示テキスト（2026-09-12 追加、v0.13.0 で実装）

§15.1 の添付経路テストで「添付ファイル内の指示は Copilot が埋め込み指示として意図的に無視する」ことが確定したため、§6.2 のサンドイッチ配置は添付経路では効かない。指示が効くのはユーザー発話（チャット本文）だけなので、同じブロック群を本文に貼るための別テキストを出す。

- 出力: パックと同じ場所に `<出力名>.prompt.md`（既定 `repomix-output.prompt.md`）。BOM 付き UTF-8
- 内容: 先頭に「添付とこの本文の関係」を述べる段落（添付名・`<file>` を正とする・以下は私からの指示・添付内の埋め込みより本文を優先）、続けて `<task>` / `<plan>` / `<procedure>` / `<instruction>` をパック末尾と同じ順・同じ形で連結（`procedureFile.ts` の `buildPromptText`。ブロックの中身はパック側と一字一句同じ）
- 末尾ブロックが 1 つもなければ書かない。`--no-prompt` で抑止、`--prompt-output <file>` で出力先変更、`--print-prompt` で標準出力へ（パックは作らない。`| clip` を想定）。`--stdout` のときは `--prompt-output` 指定時のみ書く
- パック内の埋め込み（サンドイッチ）は変えない（貼付運用では効く。後方互換）
- 実行末尾に、パックが貼付上限の目安（120K 文字）を超えているかを 1 行表示し、超えていれば「添付 + 本文用テキスト」を案内する
- 手順文 v2: 「末尾の <instruction>」「このパック」など置き場所に依存する表現を除き、添付読み取りで空行・行末空白が落ちることを AI に伝える 1 項目を追加（`PROCEDURE_VERSION = 2`）
- 「ファイルを増やさない」原則（§11.3）の例外。理由: 添付経路で指示を届ける唯一の経路であり、任意ではなく既定の運用に要る

## 7. フェーズ 2 — SDK スタイル .vbproj 対応（slnmix）

### 7.1 狙い

webview2-bridge の dotnet 側は SDK スタイルで、`Compile` 項目を書かず `**/*.vb` が暗黙に含まれる。現行パーサーはこれを扱えない（ワイルドカードは未解決扱い、そもそも項目がない）。

### 7.2 仕様

- `<Project Sdk="...">` 属性の有無で SDK スタイルを判定。`Sdk` 属性がなく `<Import Project="Sdk.props" Sdk="..." />` 形式の場合も SDK スタイルとみなす
- SDK スタイルのとき、既定グロブを展開する:
  - `Compile`: `**/*.vb`（プロジェクトディレクトリ配下を再帰走査）
  - 除外: `bin/**`、`obj/**`、`**/*.user`、`<Compile Remove="...">` に一致するもの、`<DefaultItemExcludes>` があればそれも
  - `<EnableDefaultCompileItems>false</EnableDefaultCompileItems>` なら既定グロブを展開しない
  - 明示 `<Compile Include>` / `<Compile Update>` は既存どおり扱う（`Update` は `DependentUpon` 等のメタデータ付与として解釈）
- 展開したことを診断（info）と `<file_summary>` に明記する: 「このプロジェクトは SDK スタイルのため、既定の Compile グロブ（**/*.vb）を展開しました。MSBuild の完全評価ではありません」
- `.vbproj` の `Remove` に書かれたグロブは最小限のワイルドカード（`*` / `**`）だけ解釈する。それ以外の MSBuild 式は従来どおり未解決として記録
- `Designer.vb` の判定（`isSensitive`）は SDK スタイルでもファイル名規則で同様に行う。`Generated/` 配下の扱いはフェーズ 3

### 7.3 実装メモ

- `vbprojParser.ts` に `projectStyle: "legacy" | "sdk"` を `VbprojParseResult` に追加
- グロブ展開は `FsDeps` に `listFilesRecursive(dir): string[]` を追加して注入（テスト可能に）
- `.gitignore` の適用は既存の `GitignoreEvaluator` をそのまま通す
- テストフィクスチャ: SDK スタイル最小プロジェクト（`Remove` あり / `EnableDefaultCompileItems=false` あり）

---

## 8. フェーズ 3 — extraRoots、契約サマリー、web マスク、物理パス化（slnmix）

### 8.1 `slnmix.config.json`（任意）

ルート直下に置く。**なくても動く**。

```jsonc
{
  "extraRoots": [
    {
      "path": "apps/web",
      "kind": "web",
      "include": ["src/**/*.{ts,tsx,css}", "package.json", "vite.config.ts", "index.html"],
      "exclude": ["src/generated/**"]
    },
    { "path": "contract", "kind": "contract", "include": ["contract.ts", "package.json"] }
  ],
  "contractSchema": "contract/contract.schema.json",
  "generatedDirs": ["dotnet/App.Contract/Generated", "apps/web/src/generated"]
}
```

- `extraRoots[].path`: ルート相対。**宣言されたディレクトリだけ走査する**（ディレクトリ走査をしない原則の、明示的でスコープの狭い例外）
- 既定の除外（`include` に関わらず常に除外）: `node_modules/**`、`dist/**`、`build/**`、`.vite/**`、`**/*.map`、`.env*`、`.gitignore` / `.repomixignore` に一致するもの、バイナリ拡張子
- `include` 省略時の既定: `**/*.{ts,tsx,js,jsx,css,json,html}`（`kind: web`）、`**/*.ts`（`kind: contract`）
- `contractSchema` / `generatedDirs` は `webview2-bridge.gen.json` が同階層にあれば**自動検出**して既定値にする（§8.3）。明示すれば上書き

### 8.2 出力上の扱い

- `<directory_structure>` にプロジェクトと並べて `[web] apps/web/` のようにグループ表示
- `<file path="apps/web/src/App.tsx" root="web">` のように `root` 属性で区別
- 文字コードは UTF-8 前提（既存の `decodeSourceBuffer` を通すので Shift_JIS が混じっても壊れない）
- **認証情報マスクを extraRoots にも適用する**（既存 `credentialMasker` をそのまま通す）。`.env*` は既定除外。API キーらしき値は厳格モードでマスクされる。これを README に明記する（VB 側で守っている安全性が web を足した瞬間に落ちないように）

### 8.3 `<contract_summary>`

- `contractSchema`（`contract.schema.json`）を読み、メソッド・イベント・DTO の一覧を生成して `<files>` 内の契約ファイルの直後に埋め込む（`ui_summary` と同じ発想）
- `generatedDirs` 配下は既定で除外し、`<skipped_files>` に「生成物（contract_summary で代替）」と理由を書く。`--include-generated` で原文を含める
- 形式案:

```xml
<contract_summary path="contract/contract.schema.json">
契約から生成された API の要約（生成コード Generated/ と src/generated/ は除外。契約の正本は contract/contract.ts）:
methods:
- parts.search(req: PartsSearchRequest) -> PartsSearchResponse
- parts.get(id: string) -> Part | null
events:
- parts.changed(payload: PartsChangedEvent)
types:
- PartsSearchRequest { keyword: string; limit?: number }
- Part { id: string; name: string; updatedAt: string(ISO 8601) }
</contract_summary>
```

- `contract.schema.json` の構造は `packages/gen/src/schema.ts` を正として読む。slnmix 側に zod は入れない（JSON をそのまま読む）。スキーマ形式が変わったときに追従できるよう、`$schema` またはバージョン欄があればそれを確認し、未知の形式なら「要約できなかった」と `<skipped_files>` に書いて原文（`contract.ts`）だけ出す

### 8.4 物理パス化（重要・petari 連携の前提）

現行の `<file path>` は `プロジェクト名\論理パス`（`\` 区切り）。petari は「ルート相対・`/` 区切り」しか受け付けないため、AI がパス変換を行っている状態であり、Link ファイルやプロジェクト名 ≠ 物理フォルダ名のときに新規作成の置き場所が定まらない。

変更:

- `<file path>` を**ルート相対の物理パス・`/` 区切り**にする（例: `App/Forms/OrderForm.vb`）
- 論理パスと異なる場合（Link）、`logical="..."` 属性と `project="App"` 属性を付ける
- `<directory_structure>` は従来どおり論理ツリー（人が読む用）。ただし各行末に物理パスが異なるものは `→ 物理パス` を併記
- `<file_summary>` に規則を明記: 「path 属性はルート `<ルート名>` からの相対物理パスです。changes.md のパスはこの path をそのまま使ってください。新規ファイルも同じ規則で、置きたいプロジェクトの物理フォルダ配下に書いてください」
- **後方互換を破る変更**。バージョンを上げ（minor）、README に明記する。`--legacy-paths` で旧形式に戻せるようにする（1〜2 バージョン残して廃止）

---

## 9. フェーズ 4 — `--focus` / skeleton / シンボル索引 / `--budget`（slnmix）

**着手条件: §15.1 の入力上限測定を実施し、全件出力が上限に収まらないケースが実際にあること。** 収まるなら本フェーズは不要。

### 9.1 狙い

削るためではなく「必要なものを落とさずに縮める」ため。外したファイルは骨格（シグネチャ）として残し、存在しない API のでっち上げを防ぐ。

### 9.2 オプション

```
--focus <ファイル名|フォーム名|パターン>   複数可。論理パス・物理パス・型名のいずれにも全体一致（* 可）
--depth <N>                              focus からの参照追跡の深さ。既定 1
--budget <文字数>                         超過時に遠い段から skeleton へ降格。既定なし
```

`--focus` なし = 従来どおり全件 full（原則 2）。

### 9.3 段の決め方

| 段 | 対象 | 出し方 |
|---|---|---|
| full | focus に一致したファイル + その `DependentUpon` 群（Designer / resx の要約含む）+ depth 以内の依存先 | 全文 |
| skeleton | それ以外の Compile ファイル | シグネチャのみ（§9.5） |
| summary | focus のフォームの Designer.vb | `<ui_summary>`（focus 外のフォームは `<ui_summary>` を出さず、フォーム名とタイトルの 1 行のみ） |

- `<file_summary>` に「全文: N 件 / 骨格のみ: M 件」と各ファイルの段の一覧を載せる
- `<dependency_graph>` ブロックで `focus → 依存先` を列挙し、なぜそのファイルが full なのかを示す
- `--budget` 超過時は depth の大きいものから順に skeleton へ降格し、降格したことを `<file_summary>` に明記する。focus 自体は降格しない（収まらなければエラーで止め、`--focus` を減らすよう案内）

### 9.4 シンボル索引（`services/symbolIndex.ts`、コア）

正規表現ベース。完全な VB 構文解析はしない（既存方針）。

抽出するもの:
- `Namespace` / `Class` / `Module` / `Structure` / `Interface` / `Enum` / `Delegate` の宣言（修飾子、`Partial`、`Inherits` / `Implements`）
- Public / Friend / Protected のメンバ: `Sub` / `Function` / `Property` / `Event` / `Const` / `Dim`（モジュールレベル。`WithEvents` 含む）
- `Private` メンバは skeleton に含めない（本体理解は full で行う）。ただし Module の Private は「他から呼べない」判定に使う

参照検出（focus ファイル内の識別子 → 索引）:
- 確度高: `Inherits X` / `Implements X` / `New X(` / `As X` / `Handles X.Y` / `X.Y(` で X が索引の型名または Module 名
- 確度中: Module の Public メンバ名の裸呼び出し（VB は Module メンバを修飾なしで呼べる）。名前一致で拾い、偽陽性は許容
- 大文字小文字は区別しない

VB 固有の落とし穴（テストフィクスチャで必ず押さえる）:
- `_` による行継続（シグネチャが複数行にまたがる）
- 属性 `<Extension()>` / `<Obsolete("...")>` の前置
- 複数行にまたがる `Handles` 句
- `Partial Class` が複数ファイルに分かれる（Designer と本体）
- `Option Strict` 等のファイル先頭指令、`Imports`
- 日本語識別子（VB は許容。`\w` に頼らず Unicode 文字クラスで）

### 9.5 skeleton の形式

```vb
' [skeleton] 本体は省略。シグネチャのみ。変更対象にする場合は全文を要求すること
Public Class OrderService
    Inherits BaseService
    Public Shared ReadOnly DefaultLimit As Integer = 100
    Private WithEvents timer As Timer   ' Private でも WithEvents は残す（イベント配線の理解に必要）
    Public Sub New(conn As IDbConnection)
    Public Function Search(keyword As String, Optional limit As Integer = 100) As List(Of Order)
    Public Event Changed(sender As Object, e As EventArgs)
End Class
```

- 元の行の並び順を保つ。`End Sub` / `End Function` は出さない（本体がないことを明確に）
- `<file path="..." tier="skeleton">` 属性で区別

### 9.6 実装メモ

- 索引・段決定・skeleton 生成はすべてコア（`services/`）。CLI は `--focus` 等をオプションに変換するだけ
- `RepomixExportOptions` に `focus?: { patterns: string[]; depth: number; budget?: number }` を追加
- 手順文（§6.5）の「骨格のみ」の一文は本フェーズで意味を持つ。フェーズ 1 の時点で入れておいてよい（骨格ファイルが存在しなければ無害）

---

## 10. フェーズ 5 — 境界またぎのリンク（slnmix + webview2-bridge 任意）

### 10.1 狙い

`--focus PartsApi` で、React 側の呼び出し箇所（`client.parts.search(...)`）と VB 側の実装（`Impl/PartsApi.vb`）を一度に full で引く。契約をまたぐ変更の文脈を 1 回で揃える。

### 10.2 仕様

- `<contract_summary>` のメソッド名を索引に登録し、TS 側（`client.<group>.<method>(`、生成型名）と VB 側（`Implements I<Group>Api`、生成インターフェースのメソッド名）の両方から参照として辿れるようにする
- 名前の対応規則は `webview2-bridge` の `naming.ts`（pascalCase / vbEscape / toIdentifier）に依存する。**slnmix に複製すると規則変更時に追従が切れる**ため、以下のどちらかを選ぶ:
  - (a) webview2-bridge の gen が `contract.names.json`（契約名 → TS メンバ名 / VB インターフェース名・メソッド名 / DTO 型名）を書き出す（任意拡張、§12）。slnmix はそれを読む。**推奨**
  - (b) (a) がない場合の暫定として slnmix 側に規則を写す。`<file_summary>` に「名前対応は slnmix 内の規則で推定」と明記
- (a) が存在すれば (a)、なければ (b) にフォールバックする

---

## 11. petari の改修

### 11.1 P1-a: vbproj 対応 `create`

**背景**: 旧スタイル .vbproj は `<Compile Include>` に載っていないファイルをコンパイルしない。AI にこれをやらせると、パックに .vbproj 本体がないため SEARCH が一致せず失敗する。知らなければファイルはできても VS 上に現れない。どちらも「新規が絡むと失敗」に見える。**AI ではなく petari が機械的に登録する。**

仕様:

- `create` の対象が `.vb` のとき、作成先ディレクトリから上へ辿り、**プロジェクトルートまでの間で最寄りの `*.vbproj`** を探す
  - 見つからない → 登録せず、レポートに「vbproj が見つからないため未登録」と出す（失敗にはしない）
  - 複数の `.vbproj` が同じディレクトリにある → 登録せず警告（人が決める）
  - SDK スタイル（`<Project Sdk=...>` / `Sdk.props` Import）→ 登録不要。レポートに「SDK スタイルのため登録不要」
- 旧スタイルで未登録なら、`Compile` 項目を含む最初の `<ItemGroup>` の末尾に追加する。`Compile` 項目を含む `ItemGroup` がなければ新しい `ItemGroup` を最後の `ItemGroup` の後に作る
  - `Include` は .vbproj からの相対パス・`\` 区切り
  - インデントは同じ `ItemGroup` 内の既存項目に合わせる（なければ 4 スペース）
  - 追加行のみを挿入し、他の行は元バイト列を書き戻す（既存の行単位ドキュメント方式をそのまま使う。エンコーディング・改行・BOM は保たれる）
- 新規ファイルの内容に `Inherits System.Windows.Forms.Form` / `Inherits Form` / `Inherits UserControl` 等があれば `<SubType>Form</SubType>`（UserControl は `UserControl`）を付ける
- 同じ changes.md 内で `X.vb` と `X.Designer.vb` の両方が `create` される場合、`X.Designer.vb` に `<DependentUpon>X.vb</DependentUpon>` を付ける。`.resx` の生成は行わない（フォームの新規作成は当面 VS で行う運用。§14-6）
- 既に登録済み（`Include` が一致）なら何もしない（冪等）
- `delete` で `.vb` を消したときの `.vbproj` からの除去は**行わない**（削除は影響が大きく、VS 側でエラーとして見える方が安全。§17 に記録）
- 無効化: `.petari/config.json` の `"vbproj": { "register": false }` または `petari apply --no-vbproj`
- history / undo の対象に .vbproj の変更も含める（undo で登録も戻る）
- レポート例: `vbproj に登録: App/App.vbproj ← Services/OrderService.vb`

実装配置（petari の層構成に従う）:
- `src/core/vbproj.ts`: 純粋関数。`(vbprojText: string, relInclude: string, opts: { subType?: string; dependentUpon?: string }) → { text: string; changed: boolean; reason?: string }`。判定（旧/SDK、登録済み）と挿入位置計算・行挿入。XML パーサは入れない（実行時依存ゼロ）。正規表現 + 行処理で `<ItemGroup>` / `<Compile Include="...">` を扱う。整形が特殊な .vbproj（1 行に複数要素、CDATA 等）は「登録できない形式」として未登録扱いにし、壊さない
- `src/infra/vbproj.ts`: 最寄り .vbproj の探索（ファイル I/O）
- `src/commands/apply.ts`: create 成功後に呼ぶ。失敗しても create 自体は成功扱い（レポートに載せる）
- テスト: 旧スタイル（登録あり / なし / 登録済み / Form / Designer+DependentUpon / Shift_JIS+CRLF の .vbproj）、SDK スタイル、vbproj なし、複数 vbproj

### 11.2 P1-b: 新規ファイルのエンコーディング推定

**背景**: 現行既定は `utf8` / `lf` / BOM なし。日本語コメントを含む `.vb` を BOM なし UTF-8 で作ると、vbc / VS はシステムコードページ（CP932）とみなして化ける。Shift_JIS / CRLF の既存ファイルと混在もする。

仕様:

- `newFile.encoding` に `"auto"` を追加し、**`petari init` の雛形の既定を `"auto"` にする**（既存ユーザーの config は変えない。README に案内）
- `auto` のとき、作成先と同じディレクトリの既存テキストファイル（同じ拡張子を優先、なければ任意のテキスト）を検出し、多数決で `encoding` / BOM / `eol` を決める
  - 同じディレクトリに手本がなければ、上位ディレクトリを 1 段ずつ辿る（ルートまで）
  - それでもなければ拡張子別の既定: `.vb` → `utf8` + **BOM あり** + `crlf`、それ以外 → `utf8` / BOM なし / `lf`
- `.vb` で結果が `utf8` かつ BOM なしになった場合（ASCII のみの Shift_JIS ファイルが UTF-8 判定される既知の限界に由来）、**BOM を付ける**。理由: BOM なし UTF-8 の日本語は vbc で化けるが、BOM 付き UTF-8 は VS / vbc とも正しく読める。Shift_JIS が本来の期待でも実害は出ない（差分は BOM の有無だけで、コンパイル結果は同じ）
- レポートに採用した設定と根拠（「同ディレクトリの 5 ファイル: shift_jis/crlf」等）を 1 行出す
- 明示指定（`"utf8"` / `"shift_jis"`、`bom`、`eol`）があれば従来どおりそれを使う

### 11.3 P2: 目録による警告（任意・フェーズ 4 後）

- slnmix が `--manifest` 指定時に `repomix-output.manifest.json`（含めたファイルの物理パスと段）を隣に書く。既定では書かない（ファイルを増やさない原則）
- petari は `.petari/config.json` の `manifest` にパスがあれば読み、changes.md が「骨格のみのファイル」「パックに含まれていないファイル」を変更しようとしていたら**警告**する（既定は続行。`--strict-manifest` で失敗扱い）
- モデルの自己検証をすり抜けたものを機械的に止める保険。優先度は低い

### 11.4 `protocol.md`（規約文）への追記

`create` / `.vbproj` の扱いは手順文（slnmix 側）に書くが、出力形式に関わる次の 1 点は `protocol.md` にも追加する（`PROTOCOL_VERSION` を上げる）:

- 「SEARCH ブロックは、一意に特定できる範囲のうち**最小**（目安 3〜8 行）にする。大きな範囲は一致に失敗しやすい。ファイルの過半が変わるなら rewrite を使う」（既存 3 項の補強）

---

## 12. webview2-bridge の任意拡張

- `pnpm gen` が `contract.names.json` を出力する（出力先は `webview2-bridge.gen.json` で指定、既定は `contract/` 隣）。内容: 契約上の名前ごとに TS 側メンバ名、VB 側インターフェース名・メソッド名・DTO 型名、生成ファイルのパス
- これは §10 の (a) 用。フェーズ 5 に入るまで不要。gen のバージョンを minor で上げる
- それ以外は触らない

---

## 13. workbench の凍結と CLAUDE.md の更新（フェーズ W）

- slnmix の CLAUDE.md から「コアは Legacy VB.NET Workbench と二重管理」の節を削除し、次に置き換える:
  - 「解析コアは slnmix が唯一の置き場。legacy_vb_workbench は 2026-09 時点で凍結（新機能は追わない）。将来 workbench で新コアが必要になったら、slnmix に `index.ts` で公開 API を追加して依存させる。パッケージ分離はそのとき検討する」
  - 意図的な差分 2 箇所（ツール名・Designer スキップ理由の文言）の制約を解除
- workbench の README / CLAUDE.md に凍結の旨を 1 段落追記（コードは触らない）

---

## 14. 要確認事項・未決定

1. **Copilot Chat の入力上限**（§15.1）。フェーズ 4 の着手判断に必要。貼り付けと添付で差があるかも含む
2. **実際に使われているモデル**。Excel 365 のモデルセレクターに「Opus v5」「Opus 4.8」が並ぶかで判別できる可能性。Opus 5 なら性能差は縮まる
3. **petari のプロジェクトルート**。`findProjectRoot` が返す場所と slnmix のルート（.sln のディレクトリ）が一致する運用にする。`.petari/` と `protocol.md` を .sln の隣に置く前提でよいか。webview2-bridge 構成では .sln がリポジトリ直下にない可能性があるので、その場合の基準を決める（候補: `slnmix.config.json` の `root` で明示 / `.petari/` のある場所を slnmix も基準にする）
4. **新規ファイルの失敗の実態**。§11.1〜11.2 は 3 つの仮説（.vbproj 未登録 / エンコーディング / パス基準）をすべて塞ぐ設計だが、実際のエラーメッセージや症状が分かれば優先を絞れる
5. **回答の出力上限**。手順文で回答が長くなり changes.md が途中で切れるリスク。`implement` モードで調査を省くのはその対策。それでも切れる場合、複数回答への分割規約（`changes.md` を `(1/2)` `(2/2)` に分け、petari が連結して適用）を検討する。まずは実運用で切れるかを見る
6. **フォームの新規作成**。`Designer.vb` + `.resx` + `DependentUpon` の 3 点セットが要る。当面は「VS で空フォームを作る → 中身は AI」。petari で `.resx` の雛形まで生成するかは後回し
7. **`contract.schema.json` の安定性**。`schema.ts` の形式が変わったとき `<contract_summary>` が壊れないよう、バージョン欄の有無を確認する
8. **物理パス化（§8.4）の影響範囲**。既存の Link ファイルで、物理パスがルートの外（別ドライブ）にあるものは petari で適用できない。その場合 `path` はどうするか（候補: `logical` を主にし `physical="D:/..."` を情報として付け、`<file_summary>` に「このファイルは適用ツールの範囲外」と明記）

---

## 15. 計測

### 15.1 入力上限の測定（フェーズ 4 の前提）

1. 1,000 文字ごとに `<!-- MARK 0001 -->` のような行を仕込んだダミーテキストを生成する（slnmix に `--probe <文字数>` を一時的に付けてもよいし、スクリプトでもよい）
2. Copilot Chat に貼り付けて「最後に見えた MARK の番号だけ答えて」と聞く
3. 同じものを添付（ファイルアップロード）でも試す
4. 200K / 400K / 800K 文字の 3 点で行い、実効上限と貼付/添付の差を記録する
5. 結果を §17 に記録。現在の実業務ソリューションの全件パックの文字数（slnmix の末尾表示）と比較し、フェーズ 4 の要否を決める

**測定結果（2026-09-12、ダミーは `test_rep/probe/`、1,000 文字ごとに MARK 行）**

| 経路 | 200K | 400K | 800K | 備考 |
|---|---|---|---|---|
| 貼付（入力欄にペースト） | MARK 0122 付近が限界 | — | — | 上限 **約 120K 文字**。入力欄はペースト自体を受け付けるが、上限を超えると**送信ボタンが非活性になり送信できない**（黙って切り詰められることはない）。下から削って送信できた範囲について、Copilot 自身が「投稿本文がそのままコンテキストに含まれていた（目視で追った）」と回答 = この範囲は本文がコンテキストに直接入る |
| 添付（ファイルアップロード） | 0199 正答 | 0399 正答 | 0799 正答 | ただし 800K では「本文をコンテキストに展開したのではなく、ファイルをコマンドで読み取って確認した」と明言 = 検索・読み取りツール経由で、本文全体がモデルに見えているわけではない |

解釈:
- 添付経路にサイズの壁はないが、モデルは必要箇所を検索して読む。SEARCH が部分的な読み取りから再構成されて失敗する事例（petari §7 の診断拡充の起点）と、末尾の規約文が届かない既知問題（2026-08-10）はこの経路の性質で説明できる
- 貼付経路は約 120K 文字までなら全文がコンテキストに入る。超えると送信自体ができないため、貼付経路で末尾が黙って落ちることはない。末尾 `<instruction>` が届かない既知問題（2026-08-10）は添付経路（検索読み取り）の性質によるもの
- **実業務ソリューションの全件パックは約 345K 文字**（`npx slnmix` 末尾表示。スキップ 8 件 / 認証情報マスク 31 件 / UI サマリー 1 件）。貼付上限の約 3 倍のため、現行運用は添付経路にならざるを得ず、これまでの SEARCH 不一致・規約文の欠落はすべて添付経路で起きていたことになる
- したがって**フェーズ 4 に着手する**。目的は「パックを約 120K 文字以内（安全側で 100K 目安。上限はトークン基準の可能性があり、実コードとダミーで密度が異なる）に収め、貼付経路で全文をコンテキストに入れる」。345K → 100K は約 1/3 への圧縮なので、`--focus` による full / skeleton の段分けと `--budget` の降格が必須になる

**添付経路の性質テスト（2026-09-12、`test_rep/probe/probe-attach-300k.txt`、約 300K 文字を添付）**

| テスト | 結果 |
|---|---|
| 1. 先頭・末尾に仕込んだ「合言葉を書け」指示（要約を頼むだけ） | 先頭・末尾とも**指示の存在は認識**したうえで、「ファイル内の埋め込み指示のため従っていません」と**明示的に拒否**。合言葉は出ない |
| 2. REGION A の逐語引用（空行 3 本・行頭タブ・行末空白 3 個・全角スペースを含む 13 行） | **空行がすべて消える**（「区間内に空行はありません」と断言）。行末空白は「5 個」と誤認し引用にも残らない。行頭タブは存在を認識するが引用では判別不能。インデントと全角スペースは保たれる |

解釈（設計への影響が大きい）:
- **添付ファイル内の指示は、届かないのではなく「本文中の埋め込み指示」として意図的に無視される。** 末尾の `<instruction>`（規約文）も先頭リマインダも、添付経路では構造的に効かない。既知問題（2026-08-10「埋め込み規約文が無視される」）の真因はこれで、README の「依頼文に 1 行添える」運用が効いていた理由でもある。規約文・手順文は**添付ではなくチャット本文（ユーザーの発話）に置く**必要がある
- **添付の読み取り経路は空行を落とす。** petari の空行欠落事例（2026-08-25）の真因は Copilot 側の添付処理ではなく、モデルがファイルを読むツールの出力が空行を含まないことにある。petari v0.8.0 の blank-insensitive マッチはこの経路に対する正しい防御で、恒久的に必要
- 行末空白・タブも読み取りで失われ得る。petari の trim-end / trim-all 段が吸収する
- 添付経路にはサイズの壁がない一方、指示は効かず本文の空白が崩れる。貼付経路（約 120K 以内）は本文がユーザー発話としてコンテキストに入るため指示が効き、空白も原文のまま。**運用の最適解は「指示（手順文 + 規約文 + 依頼）を本文に貼り、コードは添付」、精度が要る変更では「絞り込んだコード（100K 以内）も本文に貼る」**

### 15.2 効果の測定（フェーズ 1 の検証）

- 過去に AI に依頼したタスクから 3〜5 件を選び、パック・依頼文・期待する変更を固定する
- 手順文あり / なし（`--no-procedure`）で同じ依頼を投げ、次を数える: petari の適用成功（初回）/ ビルド通過 / 質問で止まった件数（曖昧なタスクを 1 件混ぜる）
- 主観評価は「方針セクションの内容が妥当か」の 3 段階
- 記録は簡単な表でよい。改善のたびに同じセットで再測定する

---

## 16. 完了条件

各フェーズ共通: `pnpm test` / `pnpm typecheck`（petari）または `pnpm test`（slnmix: tsc → mocha）が全パス。README 更新。バージョン更新（`npm publish` はメンテナー本人）。

| フェーズ | 完了条件 |
|---|---|
| 1 | `--no-procedure` で従来出力と完全一致。3 モードの出力がスナップショットテストで固定。`procedure.md` 上書きが動く。`--print-procedure` が動く |
| 2 | SDK スタイル最小プロジェクトのフィクスチャで Compile 一覧が期待どおり。`EnableDefaultCompileItems=false` / `Remove` が効く。展開の宣言が出力に含まれる |
| 3 | `slnmix.config.json` なしで従来どおり動く。`extraRoots` で web ファイルが同じパックに入り、`.env` と `node_modules` が入らない。`<contract_summary>` がフィクスチャの schema から生成される。web ファイルにマスクが効く。物理パス化が Link あり/なしの両方で正しい。`--legacy-paths` で旧形式 |
| P1 | 旧スタイル .vbproj への登録が Shift_JIS / CRLF のフィクスチャで他の行を 1 バイトも変えない。SDK スタイルは登録しない。undo で戻る。`auto` の推定がフィクスチャ（同ディレクトリ shift_jis/crlf）で一致。`.vb` の BOM なし UTF-8 を作らない |
| 4 | `--focus` なしで従来出力と一致。focus 時に `<file_summary>` の段一覧・`<dependency_graph>` が出る。skeleton のフィクスチャ（行継続・属性・複数行 Handles・日本語識別子）が期待どおり。`--budget` の降格が明記される |
| 5 | `contract.names.json` あり/なしの両方で `--focus <契約名>` が TS/VB 両側を full にする |
| W | slnmix CLAUDE.md から二重管理の記述が消えている。workbench に凍結の記述がある |
| 6 | `docs` 設定なしで従来出力と完全一致（手順文は版番号のみ差）。`--init-docs` が冪等。状態行 draft / ready / なし / 複数 draft でモードと既定タスクが仕様どおり。design モードの本文用テキストに対象の設計書が、他モードに引継ぎ書が入る。4 モード × docs あり/なしの手順文がスナップショットで固定。ひな型 3 種が本文用テキストに載る |

---

## 17. 決定ログ

| 日付 | 決定 | 理由 |
|---|---|---|
| 2026-09-11 | 手順文（procedure）は slnmix が内蔵し、`protocol.md` とは分離する | 責務が違う（考え方 vs 出力形式）。petari の正本方式を真似て外部ファイル必須にすると `slnmix init` が要る。原則 1 |
| 2026-09-11 | `slnmix init` は作らない。`slnmix.config.json` / `procedure.md` は任意 | 必須セットアップは `petari init` 一回のみ |
| 2026-09-11 | 絞り込み（`--focus`）は上限測定後に着手。既定は全件出力 | 削るより抜け落ちない方を優先。上限に収まるなら不要 |
| 2026-09-11 | 解析コアは slnmix 単独。workbench は凍結。パッケージ分離はしない | workbench をほぼ使っていない。petari 経由の反映が主で、手編集前提のツールの価値が下がった |
| 2026-09-11 | `.vbproj` への登録は AI ではなく petari が行う | パックに .vbproj 本体がなく AI の SEARCH は一致しない。機械的処理の方が安全 |
| 2026-09-11 | `delete` 時の `.vbproj` からの除去は行わない | 削除の誤りは影響が大きい。VS 側で「ファイルがない」エラーとして見える方が安全 |
| 2026-09-11 | 新規 `.vb` は BOM なし UTF-8 を作らない | vbc / VS がシステムコードページとみなして日本語が化ける |
| 2026-09-11 | `<file path>` をルート相対の物理パス・`/` 区切りに変更（`--legacy-paths` で旧形式） | petari の受け付ける形式と一致させ、AI のパス変換をなくす。新規ファイルの置き場所を確定させる |
| 2026-09-11 | 生成コード（`Generated/` / `src/generated/`）は Designer.vb と同じ扱い（除外 + 要約） | 生成物を AI に編集させない。契約の正本は `contract.ts` |
| 2026-09-11 | 名前対応規則は webview2-bridge の gen が出す `contract.names.json` を正とし、slnmix はフォールバックのみ持つ | 規則を複製すると変更時に追従が切れる |
| 2026-09-12 | 設計書のファイル名は `docs/HANDOFF-slnmix-petari-2026-09.md`(計画段階の `HANDOFF-2026-09.md` から変更) | petari 側のセッションからも参照するため、対象リポジトリを名前に含めた |
| 2026-09-12 | `--plan` は `--mode implement` 専用、`implement` は `--plan` 必須(どちらもエラーで止める) | 方針なしで implement を走らせると「調査を省いた手順」だけが残り、質の低下を黙って招く |
| 2026-09-12 | 先頭リマインダは `<task>` / `<plan>` / `<procedure>` / `<instruction>` のうち存在するものだけを列挙する。末尾が規約文のみのときは従来文面をそのまま使う | `--no-procedure` で従来出力と完全一致させる(§16 フェーズ 1 の完了条件) |
| 2026-09-12 | 内蔵既定文の plan / implement で「(full と同じ)」となっていた箇所は実文に展開する | AI には full の文面が見えないため参照できない |
| 2026-09-12 | `--print-procedure` は `procedure.md` の有無に関わらず内蔵既定文を出す | カスタマイズの起点は常に既定文。上書き後の確認は通常出力で行う |
| 2026-09-12 | フェーズ W のうち workbench 側(README / CLAUDE.md への凍結追記)はセッション A の対象外(slnmix のみ)として残す | 複数リポジトリを跨ぐ変更はセッションを分ける運用 |
| 2026-09-12 | SDK スタイルの既定除外は `bin/**` / `obj/**` / `**/*.user` / `**/.*/**`(ドットフォルダ)に固定。`BaseOutputPath` 等のプロパティは読まない | Microsoft.NET.Sdk の既定値をそのまま使う。プロパティ評価に踏み込むと MSBuild 評価の再実装になる |
| 2026-09-12 | 既定グロブの展開は `Compile` のみ(`EmbeddedResource` の `**/*.resx` は展開しない) | `.resx` は元々出力対象外。§7 の範囲に留める |
| 2026-09-12 | 明示 `<Compile Include>` と展開結果が同じファイルを指す場合は明示側を採り、重複件数を診断に残す | MSBuild では NETSDK1022 エラーになるが、静的解析では止めずに取れた分を出す |
| 2026-09-12 | `<Compile Remove>` / `<Compile Update>` は旧スタイルでも解釈する(Update は一致項目へのメタデータ付与、Remove は適用対象なしとして info) | Remove / Update は MSBuild 15 以降の構文で形式に依存しない。旧スタイルで `Include 属性のない要素` 扱いにして警告するのは誤り |
| 2026-09-12 | `EnableDefaultCompileItems` 等が `Condition` 付き `PropertyGroup` にある場合は評価せず値を採用し、その旨を info に残す | 原則 3(推測したときは宣言する) |
| 2026-09-12 | ファイル走査(`listFilesRecursive`)は SDK スタイルのときだけ呼び、シンボリックリンクは辿らない | 旧スタイルの挙動を変えない。循環防止 |
| 2026-09-12 | ルートは入力(.sln / .vbproj)のあるディレクトリに固定(§14-3)。`slnmix.config.json` の `root` は作らない | protocol.md / .gitignore / 出力先の既定と同じ基準で分かりやすい。petari 側(`.git` 上方探索 or `--root`)と揃える運用は README に明記。`.sln` がリポジトリ直下にない構成が実際に出てきたら再検討 |
| 2026-09-12 | ルート外のファイル(別ドライブの Link 等)は `path` を `プロジェクト名/論理パス`(/ 区切り)にし、`physical` / `outside_root` 属性と `<file_summary>` の一覧で「適用ツールの範囲外」と明記(§14-8) | パス自体は petari が拒否する形にしない(絶対パス・`..` を出さない)が、適用できないことは隠さない |
| 2026-09-12 | 論理パスと物理パスが一致するファイルには `project` / `logical` 属性を付けない | 大半のファイルで冗長。差があるときだけ目立つ方が AI にも人にも読みやすい |
| 2026-09-12 | `<contract_summary>` は extraRoots の `kind: contract` のファイル群の直後に置く(なければ `<files>` 末尾) | 「契約ファイルの直後」(§8.3)を、契約ファイル名を知らなくても実現できる規則にした |
| 2026-09-12 | `contract.schema.json` は `contractVersion === 1` のみ要約する。それ以外は理由付きで `<skipped_files>` へ | §8.3 の「未知の形式なら要約しない」。zod は入れない |
| 2026-09-12 | extraRoots の既定除外(node_modules 等)は件数だけ診断に残し、`<skipped_files>` には載せない | 数千件になり出力を汚す。`exclude` / バイナリ / `.gitignore` による除外は従来どおり 1 件ずつ載せる |
| 2026-09-12 | 認証情報マスクの `KEY = 値` パターンは、値の先頭が空白・引用符のもの(コードの代入 `KEY = "..."`)を対象外にした | web 側(TS)で `= "` の間の空白が値として `[MASKED]` になり代入の形が壊れていた。引用符内は文字列リテラルとして高エントロピー判定で扱う |
| 2026-09-12 | petari §11.1 の純粋関数は「行配列 in → 挿入位置 + 挿入行 out」(`registerCompileItem`)。テキスト in/out ではなく、挿入行だけを行単位ドキュメントに差し込む | 既存の DocLine (raw バイト保持) 方式にそのまま乗せれば、挿入行以外を 1 バイトも変えない保証が実装ではなく構造で得られる |
| 2026-09-12 | petari の `.vbproj` 登録先は「Compile を含む最初の **Condition なし** ItemGroup」。Condition 付きしかなければ新しい ItemGroup を作る | Condition 付きに入れると条件付きコンパイルになり、VS 上で見えない構成が生じる |
| 2026-09-12 | `X.Designer.vb` には `<SubType>` を付けない。`<DependentUpon>` は親 `X.vb` が同じ changes.md で create されるときに加え、既にディスクにあるときも付ける | VS 自身の生成物と同じ形にする。ディスク上の親の存在は推測ではなく事実 |
| 2026-09-12 | 同じ changes.md が `.vbproj` 自体も変更する場合は、その変更後の内容に登録を重ねる(スキップしない)。manifest は AI 側の op のまま `registered` を付け、純登録は `op: "vbproj"` | AI が .vbproj を触りつつ登録を忘れるケースこそ本機能の対象。undo は before 復元で両方戻る |
| 2026-09-12 | petari `newFile.encoding: "auto"` の手本は同拡張子優先 → 任意のテキスト → 上位ディレクトリ。手本の条件は「通常ファイル・非ドットファイル・NUL なし・UTF-8/Shift_JIS としてデコード可能・1 MiB 以下」。同点は utf8 / BOM あり / CRLF 側 | 拡張子リストを持たず、デコード可否で判定する方が保守が要らない。同点の倒し方は .vb で安全な側 |
| 2026-09-12 | petari config の合成で `encoding: "auto"` のときは既定の `eol: "lf"` を混ぜない(ユーザーが明示した `eol` / `bom` は auto でも優先) | 混ぜると改行の推定が常に lf に固定され auto の意味がなくなる。従来形式(eol のみ指定)は従来どおり既定とマージし後方互換 |
| 2026-09-12 | petari §11.3(P2 目録警告)は未着手。slnmix フェーズ 4 の `--manifest` 実装後に着手する | 前提(§5 の依存)が未実装。任意項目 |
| 2026-09-12 | petari は v0.9.0 として §11.1 / §11.2 / §11.4 を同時にリリース(規約文 v4)。`petari init` の雛形の既定を `"auto"` + `"vbproj": { "register": true }` に変更、既存 config は変えない | §11.2 の指示どおり。既存ユーザーは README の案内で切り替える |
| 2026-09-22 | 動作確認の自動化(テスト戦略)は `docs/HANDOFF-testing-2026-09.md` を正本とする。Playwright Test / Vitest / Knex の上に部品 3 つ(ホスト起動 + 契約呼び出し、DB ヘルパ、レポータ)だけを自作し、L1(画面ロジック・DB なし)/ L2(契約経由の API 通し)/ L3(画面からの通し)の 3 層。テストはすべて TS で VB には書かない | 既製で 8 割揃う(調査 2026-09-22)。DB が要る層を会社 PC の 1 コマンドに閉じ込め、DB 不要の層は Claude Code が自走する |
| 2026-09-22 | 手順文 v6 でテストを標準成果物にする(「変更」にテスト同梱、自己検証 2 項目、観点は仕様書・設計書から読み取りユーザーに聞かない)。ただしパックにテストが無く `kind: "test"` の extraRoots も無いときは一切出さない(`{{TEST_SECTIONS}}` 条件付き置換) | 既存プロジェクト(旧 WinForms のみ、テスト無し)の出力を v5 と同一に保つ。会社としてテストを書いていない案件を崩さない |
| 2026-09-22 | ひな型は設計書 §9 の完了条件を「自動テスト / 手動確認」に分け、仕様書に「10. テスト」章、引継ぎ書 §7 を自動 / 手動に分ける。既存の docs/ は書き換えない | テストの観点を文書から読み取る前提を、文書側にも置く |
| 2026-09-22 | petari は無改修。失敗レポートはテスト側のレポータがクリップボードへ入れる(petari の `clipReportOnFailure` と同じ体験)。`--verify` は非信頼 config からのコマンド実行になるため見送り | 往復に petari の変更は不要。セキュリティ設計(config は非信頼入力)を崩さない |
| 2026-09-22 | ルートの決め方を「.sln の場所に固定」から「`--root` > 入力のディレクトリから上に向かって最初に見つかる `slnmix.config.json` の場所(`.git` より上には行かない)> 入力のディレクトリ」に変更(v0.16.0、`rootResolver.ts`)。設定に `target`(ルート相対の .sln / .vbproj)を足し、引数なしの `npx slnmix` がそれを使う。2026-09-12 の「ルートは .sln の場所に固定」を更新 | webview2-bridge の雛形(`dotnet/MyApp.sln`)で `web/` `contract/` `e2e/` と `webview2-bridge.gen.json` がルート外になり、petari のルート(.git の場所)ともずれる事例が出た。`.git` を自動で辿らず設定ファイルの位置で決めるのは、設定を置いていない既存プロジェクトの出力を変えないため。雛形の `.sln` を動かす案は新規アプリしか直らず、`dotnet build` の書き方も変わるので不採用 |
| 2026-09-22 | v0.15.0 手順文 v6 / ひな型 v4(フェーズ C 実装): v6 で足す文はすべて `{{TEST_SECTIONS}}` に置換される「## 自動テスト」の 1 節にまとめ、§7-1 のように既存の節(パックの読み方・変更・自己検証・判断の原則)へは散らさない。判定 `src/autoTests.ts` は実際に出力した `<file>` の path(`RepomixExportResult.filePaths`)と extraRoots の `kind === "test"` だけを見る純粋関数で、cli.ts はそのためにパック本文をモード決定より先に組み立てる(細部はテスト戦略メモ §7-8) | 既存の節に文を足すとテスト無しの本文が v5 から変わり「出力を変えない」保証(§8)を壊す。1 節にまとめれば、テスト無し = 空文字で v5 と同一になることがスナップショットで機械的に確かめられる。判定を出力結果から行うのは、除外・要約されたファイル(`.gitignore`、生成コード)を根拠にしないため |
| 2026-09-12 | §15.1 の測定結果: 貼付の実効上限は約 120K 文字（MARK 0122 付近で打ち切り、範囲内は本文がコンテキストに直接入る）。添付は 800K まで最後の MARK を正答するが、コンテキスト展開ではなくコマンド読み取り（検索）経由 | Copilot 自身の回答（「投稿本文がそのままコンテキストに含まれていた」「アップロードされたファイルをコマンドで読み取って確認した」）から判断。MARK テストは添付経路の上限を測れない |
| 2026-09-12 | フェーズ 4 の要否判定の閾値は「実業務パックが約 120K 文字を超えるか」。超えるなら着手し、目標は `--focus` / `--budget` でパックを 120K 以内に収めて貼付経路で全文をコンテキストに入れること。添付経路は補助（サイズの壁はないが本文全体が見えない） | 添付前提の運用では絞り込んでも効果が薄い（読まれる範囲は検索次第）。貼付で全文が入る状態にすることが SEARCH 精度と規約文到達の両方に効く |
| 2026-09-12 | 実業務パックは約 345K 文字（貼付上限の約 3 倍）。フェーズ 4 に着手する。目標は貼付できるサイズ（100K 目安、上限 120K）への圧縮 | §15.1 の結果。添付経路では本文全体がモデルに見えず、SEARCH 不一致と規約文欠落の根本原因になっている。貼付で全文をコンテキストに入れることが最も効く |
| 2026-09-12 | 貼付上限超過は「送信ボタン非活性」で検知できる（黙って切り詰められない）。よって slnmix はパック末尾の文字数表示に加え、貼付上限の目安（120K）を超えたら 1 行警告を出す | 利用者が貼付か添付かを判断する材料をパック生成時点で与える。フェーズ 4 の `--budget` 既定値の根拠にもなる |
| 2026-09-12 | 添付ファイル内の指示（`<instruction>` / 先頭リマインダ / `<procedure>`）は Copilot が「埋め込み指示」として意図的に無視する（テスト 1）。よって手順文・規約文・依頼文は**パックに埋め込まず、チャット本文に貼る別テキスト**として出力する（フェーズ 4 に先行する「フェーズ 1.5」）。パック内の埋め込みは貼付運用向けに残す | 添付経路では埋め込み指示が構造的に効かないことが実測で確定。指示をユーザー発話に移すのが唯一の確実な経路 |
| 2026-09-12 | 添付の読み取りは空行・行末空白を落とす（テスト 2）。petari の blank-insensitive マッチ（v0.8.0）と trim 段は添付経路の恒久的な防御として維持する。slnmix 側で空行を保つ細工はしない（読み取りツール側の挙動のため無意味） | 真因が Copilot の添付読み取りにあると確定。パック側では防げない |
| 2026-09-12 | フェーズ 4 の目的を「貼付上限に収める」から「精度が要る変更で、対象コードをユーザー発話として（100K 以内で）コンテキストに入れる」に言い換える。添付（全文・検索用）との併用が前提 | 添付は捨てない（サイズの壁がなく検索できる）。貼付は指示と空白が確実に届く。両方の長所を使う |
| 2026-09-12 | フェーズ 1.5: 本文用テキストは既定で書く（`<出力名>.prompt.md`）。「ファイルを増やさない」原則の例外 | 添付経路で指示を届ける唯一の経路で、任意機能ではなく既定運用に要る。抑止は `--no-prompt` |
| 2026-09-12 | 本文用テキストのブロック（task / plan / procedure / instruction）はパック末尾と同じ関数で組み立て、中身を一字一句同じにする。先頭段落だけが本文用固有 | 正本を 1 つに保つ。貼付運用（パック丸ごと本文）と添付運用で AI が読む指示を揃える |
| 2026-09-12 | パック内の埋め込み（サンドイッチ）は残す。`--no-embed` のような削減オプションは今は作らない | 貼付運用では効く。添付運用での余分は数 K 文字で害がない。要望が出たら検討 |
| 2026-09-12 | 手順文 v2 で「添付の読み取りは空行・行末空白を落とすので推測で補わない」を AI に伝える | 空行を補おうとして本文にない空行を入れる方が害が大きい。petari 側の blank-insensitive で吸収される前提を AI にも共有する |
| 2026-09-15 | フェーズ 6（§18）: 設計書・仕様書・引継ぎ書をプロジェクトの `docs/` に置き、slnmix がパックの `<docs>` と本文用テキストに載せる。毎回の添付をやめる | 文書を毎回チャットに添付する手間と、AI が書いた規約コピーの陳腐化（引継ぎ書サンプルに protocol v4 の「最小範囲」が抜けていた）をなくす。文書の更新も changes.md → petari で保存し、git が履歴を持つ |
| 2026-09-15 | 引継ぎ書は `docs/HANDOFF.md` の 1 ファイル固定で毎回 rewrite。段階ごとの別名保存はしない | 恒常的な知識は設計書・仕様書へ移し、引継ぎ書には「次にやること・未解決・踏んだ罠」だけを残す分担にすれば、1 ファイルで仕様を見失わない。履歴は git |
| 2026-09-15 | docs 連携は `slnmix.config.json` の `docs` で明示（自動検出しない）。ただし配置と設定の作成は `slnmix --init-docs` が一回で行う | 「設定なしで動く」（原則 1）と「ディレクトリ走査をしない」を守りつつ、利用者に mkdir や JSON 編集をさせない。§17 の「`slnmix init` は作らない」は必須セットアップを petari init 一回に保つ趣旨で、任意機能の `--init-docs` はそれと矛盾しない |
| 2026-09-15 | 作業モードは `--mode` 省略時に docs/ の状態から自動で決める（設計書なし / draft → design、ready → full、続きは引継ぎ書の有無）。`--task` 省略時も状態に応じた既定文にする | 「意識せずに設計書作成から始まる」流れを、利用者が毎回 `npx slnmix` だけ打てば成立させる。日常のコマンドは `npx slnmix` と `npx petari` の 2 つ |
| 2026-09-15 | 設計書の状態は 1 行目の機械可読な状態行 `<!-- slnmix design: status=draft\|ready blocking=N deferred=N -->` で持ち、slnmix はこれだけを読む。状態行がなければ ready 扱いにして警告（推測しない） | 本文を解釈してモードを決めると推測になる。確認事項は「必須（blocking）」と「後回し（deferred）」の 2 種類で、必須がゼロなら後回しが残っていても実装に進める（全件回答待ちで開発が止まるのを避ける）。後回しには確認期限（バッチ）を付け、バッチ着手前に AI が期限を確認する |
| 2026-09-15 | 本文用テキストには「今編集される文書」だけ入れる: design モードは対象の設計書、それ以外は引継ぎ書。設計書・仕様書の全文はパック側の `<docs>`。ひな型は本文側に `<templates>`（design: design + spec、他: handoff + spec） | §15.1: 本文は指示が効き空白が保たれる（設計書の質疑応答での SEARCH 一致に要る）が上限 120K。実測で設計書 64K + 手順文で約 81K、引継ぎ書 16K で約 29K。参照用の文書は添付の検索読みで足りる |
| 2026-09-15 | 文書のひな型 3 種（設計書 / 仕様書 / 引継ぎ書）は slnmix に内蔵（`assets/docTemplates.ts`、Mermaid の flowchart / stateDiagram / erDiagram を章立てに含む）。`docs/templates/<kind>.md` で上書き可 | 章立てを毎回 AI に考えさせない。Opus は「埋める骨格 + 記入指示 + 禁止事項」の形に強い。既存の設計書サンプル（S-BOM 機種号機登録 v0.4）の章立てを一般化した |
| 2026-09-15 | 引継ぎの引き金は AI の体感ではなく会話内で数えられる事象（バッチ完了 / changes.md 3 回 / 失敗レポート 2 回 / パック再添付）とし、毎回の回答末尾に「継続判定」を 1 行付けさせる。引継ぎ書はコード変更と別の changes.md で出す | Copilot 内のモデルは自分のコンテキスト残量を測れない。既定運用は「1 バッチ = 1 チャット」で、継続判定はその補助。別 changes.md にするのは適用後の状態を書くため |
| 2026-09-15 | 手順文 v3: `{{DOCS_SECTIONS}}` プレースホルダを追加し、docs 連携時だけ「文書の扱い」「チャットの継続と引継ぎ」の 2 節が入る。`--print-procedure` はプレースホルダを残して出す | docs を使わない利用者の手順文は v2 と本文同一（後方互換）。procedure.md に残したプレースホルダは実行時に設定に応じて置換される |
| 2026-09-15 | petari は改修しない（文書の create / rewrite は既存のパス規則・エンコーディング推定で通ることを確認済み: 日本語ファイル名可、親ディレクトリの再帰作成あり、`=======` の区切りマーカーは SEARCH/REPLACE 内でのみ解釈） | 原則 5。文書側の制約は手順文で AI に伝える（setext 見出し禁止） |

| 2026-09-15 | v0.14.1: 仕様書・引継ぎ書がないときは `<docs>` の注記と既定タスクで「最初の回答で初版を create」と明示する(design モードは除く)。ひな型を渡すだけでは AI は作らない | 既存プロジェクト(設計書と引継ぎ書はあるが仕様書がない)の乗せ替えで、利用者が `--task` で毎回頼まずに済むように。slnmix が意図を汲む側に寄せる |

| 2026-09-15 | v0.14.2 手順文 v4: バッチ完了 + ユーザーの動作確認 OK のときは同意を待たずに引継ぎ書(+ 仕様書更新)を出す「引継ぎ」と、changes.md 3 回 / 失敗レポート 2 回 / パック再添付で同意を待つ「引継ぎ推奨」を分ける。途中で引き継ぐときは引継ぎ書 §4「未解決のエラーと試したこと」に試行を残す(ひな型 v2) | 「1 バッチ = 1 チャット」を習慣ではなく既定の動きにする。一方、ビルド・実行エラーの修正ラリーは同じチャットで数回続くのが実態で、そこで勝手に切ると困る。ラリーが長引くほど失敗した試行が文脈に残り AI が引きずられるため、2 回以上失敗したら最新パックで始め直す方が早いことを AI に伝え、次のチャットが同じ試行を繰り返さない材料を引継ぎ書に残す |

| 2026-09-16 | v0.14.4 手順文 v5 / ひな型 v3: 文書が何もない完成済みプロジェクトの改修では、design モードで「改修対象の画面・機能に限った現状の仕様書(as-is)を設計書より先にコードから起こす」。設計書に「1-3. 改修の場合: 現状と変更点」を追加し、仕様書の § を参照して差分を書く。プロジェクト全体の仕様書は一度に起こさない | 実運用の次の場面(完成済みプロジェクトへの仕様追加)。設計確定時に設計書から仕様書を起こす従来の順では、既存の振る舞いが文書化されないまま変更点だけが残る。全体を一度に起こすと量が多すぎて品質もチャットも持たないため、画面単位で改修のたびに増やす |

---

| 2026-10-10 | VB.NET 以外のプロジェクト(TypeScript 等)向けに `slnmix.config.json` の `kind: "generic"` を追加(v0.17.0、§19)。`.sln` / `.vbproj` を探さず `extraRoots` だけでパックする。切り替えは明示フラグ(`target` 省略 + `extraRoots` での暗黙切り替えは採らない) | 実運用で TS プロジェクトを本家 repomix で代用し、本文用テキスト(`.prompt.md`)が無いために規約文が Copilot に届かず petari のパース失敗が続いた(2026-10-10 利用者報告、M365 Copilot / Opus 5.5)。明示フラグなら「.sln を探さなかった」理由がログに出る。設定の無い既存プロジェクトの挙動は不変 |
| 2026-10-10 | 手順文 v7: 構成の種類(layout)で VB 固有の記述を差し替える。solution の本文は v6 と同一(版数の行のみ)。差し替えは `{{LAYOUT:...}}` プレースホルダ 6 箇所と「自己検証」「自動テスト」の該当行だけで、新しい節は足さない | テスト節(v6)と同じ「既存プロジェクトの出力を変えない」方針。generic 向けに別テンプレートを持つと二重管理になる |
| 2026-10-10 | `--init-config` は実在するディレクトリ(src / app / lib / apps / packages → `kind: "src"`、tests / test / e2e / `__tests__` → `kind: "test"`)だけを書き、候補が無ければ推測せずエラー + 設定例。既存の設定は変えない | 原則 5(推測で補完しない)。`slnmix init` を作らない決定(2026-09-11)は「必須セットアップは petari init 一回」の意味で、任意機能の scaffold(`--init-docs` と同じ位置づけ)はそれと矛盾しない |
| 2026-10-10 | generic 構成では `--root` / `--legacy-paths` / Designer 関連オプションは使えない(エラーまたは警告)。`.sln` を引数で明示したときは `kind` に関わらず従来どおり論理構成で出力する(警告) | ルートは設定の場所に固定する方が petari のルートと一致しやすい。明示入力を無視すると利用者の意図を黙って覆す |
| 2026-10-10 | petari は無改修。generic 構成の `<file path>` は従来と同じルート相対の物理パスで、`newFile.encoding "auto"` と手本収集はそのまま効く。`.vbproj` 自動登録は対象ファイルが無いので何もしない | 変更が必要な根拠がない |
| 2026-10-11 | 初回セットアップを `npx slnmix init` 1 コマンドにまとめる(v0.18.0、§20)。2026-09-11 の「`slnmix init` は作らない」と原則 1 を改める | 利用者の評価(2026-10-11)で「初回セットアップが複雑になってきた」が最大の手間に挙がった。v0.17.0 時点で `petari init`(4 問の対話)→ `--init-docs` → `.gitignore` の手作業、VB.NET 以外はさらに `--init-config` と、原則 1 の「一回のみ」から実質 3〜4 手順に増えていた。日常の入口が slnmix なので初回も同じ入口にする(置き場所は利用者が選択: slnmix に集約 / petari に集約 / 2 コマンドのまま) |
| 2026-10-11 | slnmix の依存に petari を加え、`slnmix init` は同じ node で `petari init --yes --no-repomix --root <ルート>` を起動する(シェル非経由、出力は受け取って字下げ表示) | 規約文と `.petari/config.json` の雛形の正本は petari に置いたまま(二重管理しない)。petari は ESM・実行時依存ゼロなので import せず CLI を呼ぶ。petari 側に設定形式を持たせる案(petari に集約)は slnmix の設定の二重管理になるため不採用 |
| 2026-10-11 | petari init に `--no-repomix`(手順 3 の repomix 連携を丸ごと省く。petari v0.11.0) | slnmix 利用者に `repomix.config.json` は要らない。`--yes` だけで呼ぶと作られてしまう |
| 2026-10-11 | `slnmix init` はリポジトリ直下(最も近い `.git` の場所)でのみ動く。それ以外は何も書かずにエラー | petari のルートは最も近い `.git`(`findProjectRoot`)で、slnmix のルートと食い違うと changes.md の適用先がずれる(§14-3)。init で揃えておけば日常の `npx slnmix` / `npx petari` が同じ基準になる。`.git` が無ければ実行した場所をそのまま使う(petari も同じ) |
| 2026-10-11 | 構成の判定は「既存の設定 > 直下の .sln / .vbproj > 1 段下のフォルダに .sln が 1 つだけ(target に書く)> generic(`--init-config` と同じ)」。1 段下に複数・2 段以上深い場合は推測せず、target の書き方を示して止まる | 1 段下の .sln を探すのは init だけの例外(パック対象は決めず、見つけたものを設定に書いて見える形にする)。ドット始まり・node_modules / bin / obj / packages は見ない。複数あるときに選ばないのは既存の自動検出(`targetResolver.ts`)と同じ方針 |
| 2026-10-11 | `.gitignore` には生成物(`repomix-output.xml` / `repomix-output.prompt.md`)を末尾追記するだけ。既存の規則で除外済みなら足さない(判定は依存の ignore で行う)。既存部分は書き換えない | 既存の `.gitignore` が UTF-8 以外でもバイト列を変えないため。`.petari/` は petari init が足す |
| 2026-10-11 | `npx slnmix` の最後に、Copilot Chat に貼るものをクリップボードへ入れる(v0.19.0、§21)。パックが貼付上限の目安(120K 文字)以内ならパック全体、超えるなら本文用テキスト。`--no-clip` で無効、`--stdout` では入れない。失敗は警告して従来の案内に戻る | 計画のステップ 2(1 往復の手作業を減らす)の 1 件目。毎回の「.prompt.md を開いて全選択してコピー」をなくす。小さいパックは本文に丸ごと貼れば全文がコンテキストに入り埋め込みの指示も効く(§15.1)ので、添付も不要にできる。パックの場所をエクスプローラーで開く案は、毎回ウィンドウが増えるうえブラウザのファイル選択が直前のフォルダを覚えているため効果が薄く不採用 |
| 2026-10-11 | petari に `petari watch`(Downloads とプロジェクト直下を見張り、起動後に届いた changes*.md を確認なしで適用し続ける。petari v0.12.0)。運用ガイドと `slnmix init` の完了メッセージで案内する | 計画のステップ 2 の 2 件目。毎回の `npx petari` をなくす。起動前からあるファイル・書き込み途中・`## CHANGES` 見出しのないファイル・一度失敗したファイルは当てない。検証・二重適用の防止・失敗レポートの自動コピーは `petari` と共通。ダウンロード先とコードが別の PC(リモートデスクトップ越しの受け渡し)では効かないため、`npx petari` を併記する |
| 2026-10-11 | `slnmix build` を追加(v0.20.0、§22)。MSBuild でビルドし、失敗したらエラーと今のファイルの周辺行をクリップボードへ入れる。置き場所は slnmix(対象の .sln / .vbproj とルートの決め方を持っているため) | 計画のステップ 2 の 3 件目。Visual Studio でビルドしてエラー一覧をコピーし、AI が古いパックの内容で SEARCH を書いて petari の適用に失敗する往復を減らす。Visual Studio のエラー一覧のコピー形式は版と言語で列が変わるため取り込まず、MSBuild の標準のエラー形式(ローカライズされない error / warning の語を含む)だけを読む |
| 2026-10-13 | 手順文 v8: ルートに `docs/db/schema.md`(ashiato schema の出力 = テスト用 DB のテーブル定義)があるときだけ、パックに `<db_schema>` を入れ、手順文に「DB の確認」の節を足す(§23)。無いときの本文は v7 と同一(版数の行のみ) | AI チャットだけで testdb のデータ確認をしたい(2026-10-13 利用者の目標、スレッド「チャットだけでテストとDB確認」)。DB への接続と SELECT の実行は ashiato(`ashiato query`。SELECT 以外が 1 文でもあれば 1 文も実行しない)に任せ、slnmix は DB に接続しない。テーブル定義を AI に渡す経路と、確認 SQL の出し方(checks/*.sql を changes.md で create、`-- コメント` が結果の見出し)を手順文で決めておけば、往復は petari → `ashiato query` → 貼る、の 1 回で済む |
| 2026-10-13 | テーブル定義は本文用テキストに入れず、パック(添付)だけに入れる。有効にする条件はファイルの有無だけ(設定項目は作らない) | テーブルが多いと本文の貼付上限(約 120K 文字)を超える。パックが上限以内なら `slnmix` はパック全体をクリップボードに入れるので、そのときは本文にも入る。置き場所は ashiato schema の既定の出力先に固定し、設定の二重管理をしない |
| 2026-10-13 | 手順文 v9: 「DB の確認」と同じ条件(`docs/db/schema.md` の有無)で「動作検証」の節を足す(§24)。AI は操作の手順と期待する DB の変化を `checks/<名前>.verify.md` で出し、利用者は `npx ashiato verify` で手順どおりに操作して照合の結果を貼る。無いときの本文は v8 と同一(版数の行のみ) | 計画の段 3(動作検証)。何を操作して DB がどう変わるはずかを AI が決まった形で書き、照合と判定(OK / NG・違い・変わった行)は ashiato が行う。旧 WinForms を含むどのアプリでも、操作のたびに Enter を押すだけで済む。有効にする条件を分けないのは、テーブル名・列名を `<db_schema>` から引く前提が同じで、設定を増やさないため |
| 2026-10-28 | petari のブラウザ編集(127.0.0.1 の一時サーバー + 同梱の Monaco Editor)を廃止し、`petari show --edit` は VS Code 専用にする(petari v0.13.0)。slnmix の依存を `petari ^0.13.1` に上げる(slnmix v0.22.1。0.13.0 の公開物には削除したソースの古いビルドが残っていたため、build で dist/ を消すよう直した 0.13.1 を下限にする) | `slnmix init` が git リポジトリを前提にしたので、差分の確認は git(VS Code のソース管理など)で足りる。Monaco は petari の展開後 24.8MB のうち 24.5MB を占め、slnmix の依存経由で `npx slnmix` にも載っていた。導入審査で説明が要る待ち受けポートと同梱サードパーティも無くなる |
| 2026-10-31 | slnmix と petari を 1 つのツールにまとめる。統合先は petari のリポジトリとパッケージで、slnmix は互換パッケージにする(§25)。実装は会社 PC での確認の後 | 1 本の流れに 2 つの名前があり、手順文と規約文・設定・ルート・クリップボードを 2 か所で持っている。依存ゼロの方針を持っているのは petari 側 |
| 2026-10-31 | 統合後も実行時依存ゼロを守る。iconv-lite は TextDecoder、ignore と fast-xml-parser は自前の実装に置き換える(§25.3-3) | 導入審査の説明を「依存ゼロ・待ち受けなし・同梱なし」の 1 行にできる。iconv-lite との違いは不正なバイト列・0xF9 の外字・一部の 1 バイト文字だけ(全 11,536 通りで確認) |
| 2026-10-31 | 設定ファイルは新しい名前にし、`slnmix.config.json` も読み続ける。VB.NET 以外の既定を「git が管理しているファイル」にするかは統合の後で決める。ツール名(petari のままか改名か)は検討中 | 既存の利用者のファイルを書き換えずに移行できるようにする。言語汎用化は統合と別の段に分ける |
| 2026-10-31 | マスクの抜けを統合を待たずに直す。`slnmix build` のエラーの文面を伏せ(slnmix 0.22.2)、petari は失敗レポートの抜粋を伏せ、回答の `[MASKED]` を伏せた内容で照合して元の値に戻す。戻せなければ止める(petari 0.14.0)。petari には伏せる処理の写しを置き、統合で 1 つに戻す。別視点のレビュー(同日)で、伏せた表示の作り方(行ごと・行数だけ揃える)による漏れと行のずれ、伏せ字の数だけで値を埋める戻し方による値の取り違えを再現したため、伏せた範囲をファイル全体の結果から元の位置で求める方式にし、戻すのは伏せ字を含む行を一字も変えずに残した行だけにした。`slnmix build` は `.gitignore` で除外したファイルの抜粋を載せない。2 回目のレビューで、厳格モードが JWT / Bearer トークンの一部だけを伏せて残りが見えること、`--literal-masked` が実際の値を `[MASKED]` の文字で上書きし得ることを再現したため、一部だけ伏せたトークンは残りも伏せ(パックの出力もこの点だけ変わる)、変更範囲に実際の値を伏せた行があれば `--literal-masked` を使わないようにした。3 回目のレビューで、先のブロックが前後の行を変えると伏せる条件(行継続の代入など)が崩れて抜粋に値が出ること、ファイルや行の移動で `--literal-masked` が実際の値を `[MASKED]` の文字に置き換え得ること、ビルドのエラーの本文が抜粋で伏せた値を引用し得ること、伏せる範囲が非常に多いファイルで止まることを再現したため、petari は伏せた表示を元のファイルからだけ作って行ごとに引き継ぎ、変更の前後で伏せた値が減るなら `--literal-masked` を使わず、slnmix は本文の引用も伏せ、範囲の足し方を直した。4 回目のレビューでは AI に貼る文面への漏れは petari 側では見つからず、`--literal-masked` で秘密鍵などの複数行の値の移動を見逃すこと、slnmix で本文が伏せた値の一部(識別子)を引用したときの漏れ、単独の CR などで行を分けてから伏せたときのパックとの伏せ方の違い、短い値で本文を伏せすぎることを直した。5 回目のレビューでは両方とも AI に貼る文面への漏れ・パックの出力の変化は見つからず、petari の `--literal-masked` の細部と複数行の値の行の案内、slnmix の本文の伏せすぎ(ほかのファイルの語・.vb への汎用テキストの伏せ方)と遅さを直した。6 回目のレビューでは、slnmix の本文で値が語ごとにしか伏せられず、語がすべてほかの行に見えていると値が丸ごと出ること、追加ディレクトリの判定がフォルダだけでパックより伏せすぎること、petari の失敗レポートが複数行の値を伏せた行も写すよう勧めることを直した。7 回目のレビューでは、コンパイラーがエラーのないファイルの宣言を既定値ごと本文に引用して値が出ること、長い文字列の一部に同じ並びがあるだけで値を見えているとみなすこと、一部だけ伏せたトークンの判定が高エントロピーのサブドメインを持つホスト名まで伏せること、petari が文脈の行や伏せ字のない SEARCH でも行を名指ししてヒントを落とすことを直した。8 回目のレビューでは、定数を参照する既定値がシグネチャで値に置き換えて引用されて出ること、短い既定値で本文を伏せすぎること、ホスト名の除外が URL の末尾に続く JWT の署名を残し得ることと末尾のホスト名を伏せすぎること、petari が文脈の鍵の本文の行を名指ししなくなったことを直した。あわせて、本文で伏せない「見えている」語・値を、エラーのファイル全体ではなく載せる抜粋の行だけから集めるようにした。9 回目のレビューでは、予約語の引数名([Error])の既定値が出ること、文の形の伏せた値(ラベルの文言・SQL)の語で本文の not / for などを伏せすぎること(値の中の語は本文の引用の中でだけ伏せる)、連結で途中で切れた JWT の署名の残りが見え得ること、petari が一意に特定するのに使える END の行まで名指しすることを直した。10・11 回目のレビューでは今回の変更に重大な問題は見つからず、引用符の形(フランス語の ' ・ドイツ語の „“・引用符なし)によって値の中の識別子が本文に出ること(識別子らしい語は引用の外でも伏せる)、連結の続くホスト名を伏せすぎること、petari が文脈の伏せ字の行と一緒に写すと一致しない END の行を名指ししないことなどを直した。あわせて、もともと伏せていなかった形(.NET の設定ファイルの appSettings `<add key="DbPassword" value="..." />`・My.Settings の `<value>`、連結で続く VB の文字列リテラル、`DB_PASSWORD=...`、JSON の `"password": "..."`、単一引用符の値)も伏せるようにした(パックの出力もこの分だけ変わる)。12 回目のレビューでは、この追加分が TS / JSON / Python のコードを伏せすぎること(`jsonwebtoken` の版数・字句解析の `token: "keyword"`・`'%s:%s'` など)、接続文字列の閉じていない単一引用符の値を伏せなくなったこと、petari が回答で写して足した `<value>[MASKED]</value>` の行(キーが別の行にある値)を別のキーの値として戻すことを再現したため、キーは名前の最後の語で判定し、表示の文言・書式だけの値は伏せず、`token` / `credentials` は値が秘密らしいときだけ伏せ、字下げした行は `.env` とみなさないようにした。petari はその行だけでは伏せない行を元より多く書く回答を止める。あわせて C# の `@"..."` / `$"..."` と、リテラルをまたいで続く接続文字列の値も伏せる。node_modules と Python の標準ライブラリ(約 60 万行)で main と比べ、出力が変わるのは説明文の例のパスワードなど 16 行だけ、test-fixtures のパックは main と同一だった。13 回目のレビューでは、書式の差し込みとみなす `{...}` が広すぎて ODBC の `Pwd={...}` を伏せなくなったこと、前に語が付いたキー(`csb.Password = "..."`)の空白を含む値を表示の文言とみなして伏せなくなったこと、空の文字列が 2 つ並ぶ行(`password = "" OrElse userId = ""`)を 1 つの値と読むこと、petari が `"Password=" & _` の次の行を残すだけの回答を曖昧として止めること、高エントロピーの値の行は写して足しても止めないことを再現したため、差し込みは番号と書式指定だけにし、前に語が付いたキーは表示の文言の例外を使わず、petari はキーによる伏せ方でその行だけで伏せられる値かどうかで写した行を判定し、同じ行が別の伏せ方で戻せるなら戻せない候補を除くようにした。レビューの組み合わせ検査(約 460 万通り)で main より伏せなくなるのは書式の差し込みだけだった。14 回目のレビューでは、`${DB_PASSWORD:-既定値}` を差し込みとみなして既定値を伏せないこと、コメントの次の行の JSON・辞書のキーと YAML の引用符で囲んだ値を伏せなくなったこと、早く閉じた単一引用符(`Password='ab'cd;`)の後ろの値が見えること、`EncryptPassword` の `false` のような真偽値の設定を伏せること、petari が INI のセクションや If の分岐を写して足した `pwd = [MASKED]` を本番の値で戻すことを再現したため、`${...}` は名前だけのものを差し込みとし、: のキーは行頭でも認め、閉じた引用符の後ろが区切りでなければ ; まで伏せ、真偽値は伏せず、petari は伏せ字の行を元より多く書く回答を行の種類によらず止めるようにした。15 回目のレビューでは、14 回目の変更で設定ファイルの `WebhookToken` などの値を伏せなくなったこと、型の注釈つきの宣言(`password: string = "..."`)・C# の自動プロパティ・Go の `:=`・YAML のリストの項目・番号の付いたキー(`Password2`)・汎用テキストとして伏せる .vb の `Dim pwd As String = "..."` を伏せていないこと(main も同じ)、閉じた単一引用符の後ろが日本語のときに後ろまで伏せること、petari が伏せ方の違う 2 つの表示から同じ行を写す回答を止めないことを再現したため、設定ファイルのキーは値によらず伏せ、これらの宣言の形とキーの番号を扱い、petari は戻した行ごとに数えるようにした。あわせて、長い語を含む VB のコメントで時間が語の長さの 2 乗になる以前からの問題(20 万文字で約 50 秒)を直した。16 回目のレビューでは、その修正で VB のコメントの `.Password = "..."` と、型の注釈と読める `case "prod": dbPassword = "..."` の代入、? で終わるコメントの次の行のキーを伏せなくなったこと、petari の `--partial` が伏せ字の行を別のブロック・別のファイルへ移す回答の移動元の削除だけを書いて値が作業ツリーから消えることを再現したため、型の注釈つきの形は別に探し、三項演算子の判定は : の前に空白があるときだけにし、petari は戻せない変更があるとき伏せていた値を消す変更を書かないようにした。17 回目のレビューでは、VB のコメントアウトした `As String` つきの宣言(`' Dim strPwd As String = "..."`)・Python の `u"..."` などの接頭辞つきの文字列・ODBC の `Pwd={a;b}` の `;` の後ろ・URL の `user:...@host` のパスワード・バッチファイルの `set` の値を伏せていないこと(main も同じ)、16 回目の修正で : の後に空白のない型の注釈(`password:string = "..."`)と `SMTP_PASS1` を伏せなくなったこと、`token` 系のキーの `"input_token": "NextToken"` やキー名そのものの値(`SET_PASSWORD = "SetPassword"`)を伏せすぎること、`"Password="+password;` の後の数行のコードを伏せること、petari が伏せ字の行の移動先が当たらない・適用済みと判定したときにも移動元の削除だけを書くことを再現したため、これらを直した(`token` 系のキーは、値が数字を含むか、語をつないだ識別子の形でない英字の並びのときだけ伏せる)。18 回目のレビューでは、petari に重大・中程度の問題は見つからず、slnmix で VB のコメントの値に `""` があるとその後ろが見えること、VB の型文字つきの宣言(`Dim strPwd$ = "..."`)を伏せないこと、細工した長い入力で遅くなる正規表現が 2 つあること、バッチファイルの `&` でつないだ `set`・`.env` の行末コメントの扱い・Dockerfile の `ENV` / `ARG`・compose の一覧・`docker run -e`・URL の `&amp;` を含むパスワードを再現したため、これらを直した(バッチファイルの `set` は引用符の中の `&` を値のうちとし、MSBuild の `Exec` などの XML に書いたものも読む)。19 回目のレビューでは、重大な問題は見つからず、18 回目の修正で `.env` の引用符の中の ` #` から後ろが見えること・URL のパスワードの `${DB_PASSWORD:-既定値}` の既定値が見えること・SQL の `UPDATE ... SET password=?` を行末まで伏せること、以前からの Dockerfile の `ENV` の継続行と `DBPASSWORD` / `PGPASSWORD` のような区切りのないキーを伏せていないことを再現したため、これらを直した(あわせて、1 行に `set` を多数並べた細工した入力で時間が長さの 2 乗になるのを直した)。20 回目のレビューでは、重大な問題は見つからず、19 回目の修正で行の前の方に `update` という語があるとバッチファイルの `set` を伏せなくなったこと(`if /i "%1"=="update" set ...`)・別の行に分けて書いた SQL の `SET col=:col` を行末まで伏せること・細工した長いキーで遅くなること、以前からの `sqlcmd -P パスワード` などの引数で渡すパスワード・`set \"KEY=値\"` の形・`&#x40;` を含む URL のパスワードを伏せていないことを再現したため、これらを直した(SQL として除くのは `UPDATE 表名` の直後の `SET` と、値が列名に対応するバインド変数のものだけにし、コマンドの引数はパスの途中の語(`/var/lib/mysql/`)をコマンド名とみなさない)。21 回目のレビューでは、重大な問題は見つからず、20 回目に足したコマンドの引数の読み取りが `net use \\srv\share /user:x パスワード` の順・`mysql -p'...'`・行の継続・MSBuild の `&quot;...\SQLCMD.EXE&quot;`・VB の文字列の中のコマンドを取りこぼすこと、リダイレクト(`2>nul`)・変数の参照(`$Password`・`$$X`・`{password}`)・説明文の `BCP 47` を伏せすぎること、バッチファイルの `set ADMIN_PASSWORD=@admin` をバインド変数とみなして伏せないことを再現したため、コマンドの引数はコマンド名から区切り(`|` `&` `>` など)までをコマンドとして読み、sqlcmd 系の `-P` は `-U` と一緒のときだけ伏せ、バインド変数は列名と同じ名前か、後ろに `,` / `WHERE` が続くか、前に UPDATE があるときだけにした。22 回目のレビューでは、重大な問題は見つからず、21 回目のコマンドの引数の読み取りが `osql -Usa -P...` のように `-U` の後に空白のない形・`+` や `&` を含む値・`$` で始まる値を伏せなくなったこと、行の前の方の `update` という語(`if /i %MODE%==update set ...`・`rem` の行)でバッチファイルの `set` を伏せなくなったこと、`psql -P pager=off`・`sudo -u mysql`・PHP の `" . $pass . "` を伏せすぎること、1 行に多数並べた `-U a -P b` で時間が長さの 2 乗になることを再現したため、これらを直した。レビューは利用者の判断でこの回で打ち止めにした。それ以降は main より漏れる・止まる・遅くなる・ふつうのコードを大きく伏せすぎるものだけを直し、新しい形は足さない。エスケープした引用符で囲んだコマンドの引数・PowerShell の行の継続・`Invoke-Sqlcmd -Password`・YAML の引用符のない値・PHP の `=>`・Dockerfile の空白区切りの `ENV` などは統合(§25)で言語ごとに扱う | 確認で、SEARCH に伏せ字が入ると失敗レポートの抜粋に実際の値が出ること、ビルドのエラーの抜粋も伏せていないこと、伏せ字のまま書くと実際の値が消えることを再現した。会社 PC での確認では実際のコードを使うため、その前に塞ぐ(利用者の判断) |
| 2026-11-01 | 統合を会社の PC での確認を待たずに実装する(M1〜M3 を petari 0.15.0 として 1 つの PR に。公開は利用者)。名前は `src/brand.ts` の定数にまとめ、改名するときはそこと設定ファイル名・案内の文面を変える | 利用者の依頼。確認で見つかる不具合は petari 側で直す(2 か所への移し替えは起きない) |
| 2026-11-01 | ルートの決め方はパックと適用で同じ(`--root` > 上に向かって最初の設定ファイル(`.git` より上には行かない)> 最初の `.git` > 起点)。設定ファイルの無いプロジェクトで `.sln` が直下より下にあると `<file path>` の基準が変わる | changes.md のパスとパックの `<file path>` の基準が必ず一致する。`slnmix init` で作ったプロジェクトでは変わらない |
| 2026-11-01 | VB.NET 以外の既定は git が管理しているファイル(`extraRoots` が無い generic 構成)。バイナリ・ロックファイル・256KB 超・既定の除外・.gitignore は除き、理由を `<skipped_files>` に残す | 利用者の決定(2026-10-31)。言語ごとの `include` を書かなくても Python / C# / Go などがそのまま入る。一覧はリポジトリが宣言したもので、推測で対象を決めない |
| 2026-11-01 | TS / JS・Java・C#・Go・Python は言語ごとに伏せる(文字列・コメント・数値の中だけ)。字句を読み違え得る行は全体をリテラルとみなし、範囲を対応づけられなければ汎用テキストの結果のまま。失敗レポートの抜粋は汎用テキストの範囲も含める | 汎用テキストの伏せ方は `process.env.API_KEY` のようなコードまで伏せ、AI が読めず SEARCH も合わなくなる。安全側に倒すところは汎用テキストと同じ |
| 2026-11-01 | 統合したツールの名前を **tazuna** にする(npm・コマンド・リポジトリ。版数は petari の続きの 0.15.0)。petari と slnmix は tazuna を呼ぶだけの互換パッケージにする。設定ファイルは `tazuna.config.json`(旧名 `slnmix.config.json` も読む)、PC ごとの設定と履歴は `.tazuna/`(`.petari/` だけがあればそれを使い続ける)、規約文 v5 は 1 行目の名前だけを変える(§25.8-1) | 利用者の決定(tazuna / handloop / kanmon / petari のままの 4 案から)。「ぺたり」は貼り付けを連想させ、検証してから書き込む中身と逆の印象を与える。統合と同時にすれば利用者の移行は 1 回で済む。既存のリポジトリの `.petari/` は動かさない(履歴と設定を引き継ぎ、利用者のファイルを書き換えない) |

## 18. フェーズ 6 — docs/ 連携とモード自動選択（slnmix、2026-09-15 追加、v0.14.0 で実装）

### 18.1 狙い

実運用（S-BOM 機種号機登録、2026-09-15 のサンプル）では、設計書（約 64K 文字、v0.1〜v0.4 と質疑応答で育てる）と引継ぎ書（約 16K、バッチ境界でチャットを切り替えるたびに作成）を毎回チャットに添付していた。問題は 3 つ。

1. 添付の手間と、添付し忘れ・古い版の添付
2. 引継ぎ書に AI が書き写した規約・手順が陳腐化する（サンプルの B3 版は protocol v4 の「一意な最小範囲」が抜けていた）
3. 「そろそろ引継ぎ書を書いて切り替える」判断が人任せ。AI は自分のコンテキスト残量を測れない

対策: 文書をプロジェクトの `docs/` に置き、slnmix が自動で読み、文書の状態から作業モードを決める。文書の更新は AI が changes.md で出し petari が保存する。利用者の日常のコマンドは `npx slnmix` と `npx petari` の 2 つ。

### 18.2 文書と置き場（`slnmix.config.json` の `docs`）

```jsonc
{ "docs": { "design": "docs/design", "spec": "docs/spec", "handoff": "docs/HANDOFF.md" } }
// "docs": true で上記の既定配置
```

| 文書 | 場所 | 役割 | 更新者・タイミング |
|---|---|---|---|
| 設計書 (design) | `docs/design/<名前>.md`（複数可） | 開発の進め方と判断の根拠。1 行目に状態行 | AI が design モードで質疑応答ごとに replace。必須の確認事項ゼロで ready |
| 仕様書 (spec) | `docs/spec/<名前>.md` | 実装済みの振る舞いの正本。設計からの意図的な逸脱はここに残す | 設計確定時に初版（§1〜§4）、各バッチ完了時に更新 |
| 引継ぎ書 (handoff) | `docs/HANDOFF.md`（1 ファイル固定） | チャット間の申し送りだけ | チャット切り替え時に rewrite（初回 create）。コード変更と別の changes.md |
| ひな型の上書き | `docs/templates/<kind>.md`（任意） | 内蔵ひな型の差し替え | 必要なときだけ |

`slnmix --init-docs` が `docs/design/`、`docs/spec/`、`docs/README.md` を作り、`slnmix.config.json` に `docs` を追記する（既存キー保持、冪等、壊れた JSON は上書きしない）。文書ファイル自体は作らない（空の引継ぎ書があると「続きから」と誤判定するため。AI の create → petari が親ディレクトリごと作る）。

### 18.3 設計書の状態行と確認事項の 2 種類

```
<!-- slnmix design: status=draft blocking=2 deferred=3 -->
```

- `blocking` = 種別「必須」（回答がないと実装に進めない）の未回答数、`deferred` = 種別「後回し」（実装を進めながら確認期限までに回答）の未回答数
- `blocking = 0` になったら AI が `status=ready` にする。`deferred` が残っていても実装に進める
- 設計書 §10 の確認事項表は `| # | 種別 | 内容 | 確認期限 | 状態 | 回答 |`。確認期限は「設計確定前」「B-n 着手前」。実装モードの手順文は「バッチ着手前に、期限がそのバッチ以前の後回しで未回答のものがないか確認し、あれば先に質問」と指示する
- slnmix は先頭 3 行以内の状態行だけを読む。status が draft / ready 以外や数値でない件数は無効（状態行なしと同じ）。状態行がなければ警告して ready 扱い（旧形式の設計書を実装に使えるように）

### 18.4 モードの自動選択（`--mode` 省略時）と既定タスク（`--task` 省略時）

| docs/ の状態 | モード | 本文用テキストの `<docs>` | 既定タスク |
|---|---|---|---|
| 設計書なし | design（新規） | 空 | 新しい設計書を作成する |
| draft の設計書 1 件 | design（継続） | その設計書 | 設計書を質疑応答で仕上げる（必須 N / 後回し M が未回答） |
| draft が 2 件以上 | エラー | — | `--design <名前>` で対象を指定 |
| すべて ready、引継ぎ書なし | full | 空 | §9 の最初の未完了バッチを実装。着手前に §10 の後回しの期限を確認 |
| すべて ready、引継ぎ書あり | full | 引継ぎ書 | 引継ぎ書の「0. 最初にやること」に従い「2. 次にやること」を進める |

- `--design <名前|file>`: 既存なら継続、なければ `docs/design/<名前>.md` を新規作成する design モード。`--mode design` は docs 連携必須（なければ `--init-docs` を案内）
- `--mode full|plan|implement` の明示は自動選択より優先。`implement` は従来どおり `--plan` 必須（自動選択は implement を選ばない）
- パックの `<docs>` には全文書（design → spec → handoff）を `<doc path kind [status blocking deferred]>` で入れる。位置は `<skipped_files>`（`<masked_credentials>`）の後・`<task>` の前。認証情報マスクは文書にも効く
- 本文用テキストは先頭段落 → `<docs>`（今編集される文書のみ）→ `<templates>` → `<task>` → `<plan>` → `<procedure>` → `<instruction>`。`<templates>` は design モードで design + spec、他モードで handoff + spec。本文用テキストが 120K を超えたら警告

### 18.5 design モード（手順文 v3）

回答の構成: 1. 調査（受領資料と手本コードの読み取り）/ 2. 設計書（changes.md で create または replace。状態行を更新。コード変更は出さない）/ 3. 確認事項（番号付き、種別と期限）/ 4. 継続判定（「継続」または「設計確定」。確定時は仕様書の初版 §1〜§4 を同じ changes.md に含め、実装は新しいチャットで始めるよう案内）。設計モードでは引継ぎ書を書かない（設計書が引継ぎを兼ねる）。

### 18.6 手順文 v3 の docs 節（docs 連携時のみ、`{{DOCS_SECTIONS}}`）

- 文書の扱い: 3 種類の役割 / 引継ぎ書があれば最初にその §0 に従う / 設計と仕様が食い違えば仕様が正 / 文書の更新も changes.md（setext 見出し禁止 — petari の区切りマーカー対策）/ 確認事項の 2 種類とバッチ着手前の期限確認 / バッチ完了時の仕様書更新 / ひな型の使い方（該当しない章は「該当なし」、記入指示コメントは残さない）
- チャットの継続と引継ぎ: 毎回の回答末尾に「継続判定: 継続 | 引継ぎ推奨(理由)」/ 引き金は ①バッチ完了 + 動作確認 ②changes.md 3 回 ③失敗レポート 2 回 ④パック再添付 / 同意後に引継ぎ書を単独の changes.md で rewrite / 規約・手順のコピーとコード一覧は書かない

### 18.7 実装メモ

- `src/assets/docTemplates.ts`（ひな型 3 種 + docs/README + 既定設定）、`src/docs.ts`（解決・状態行・モード決定・`<docs>` / `<templates>` 描画）、`src/initDocs.ts`（scaffold）、`src/slnmixConfig.ts`（`docs` 節）、`src/procedureFile.ts`（`OutputTail.docs`、`TaskResolution` に `default`）、`src/assets/procedure.ts`（v3、design モード、`{{DOCS_SECTIONS}}`）、`src/cli.ts`（`--init-docs` / `--design`、`--mode` 省略時の自動選択、既定タスク、マスク適用）
- テスト: `docs.test.ts` / `initDocs.test.ts` / `slnmixConfig.test.ts` / `procedureFile.test.ts` / `procedure.test.ts`（`test-fixtures/procedure/<mode>.md` と `<mode>.docs.md`）
- petari は無改修。設計書のサンプル（64K）で design モードの本文用テキストは約 81K、引継ぎ書のサンプル（16K）で full モードは約 29K（いずれも貼付上限内）
- 未対応（意図的スコープ外）: 引継ぎ書の段階別保存、設計書本文からの確認事項の自動集計（状態行を AI が保つ前提）、petari 側での文書 lint

## 19. VB.NET 以外のプロジェクトへの対応(`kind: "generic"`、2026-10-10 追加、v0.17.0 で実装)

### 19.1 狙い

TypeScript 等の `.sln` / `.vbproj` の無いプロジェクトで、slnmix → M365 Copilot Chat → petari の流れをそのまま使えるようにする。実運用(2026-10-10 利用者報告)では slnmix を本家 repomix で代用した結果、本文用テキスト(`.prompt.md`)が作れず、添付末尾に埋めた規約文は Copilot(Opus 5.5)に無視され、AI の返答が changes.md の規約から外れて petari のパース失敗(§3.5 の寛容パースでも曖昧さが残る形)が続いた。失敗の大半は「規約文と手順文が本文に届かない」一点に帰着するため、slnmix 側で `.sln` 必須の制約を外すのが最も効く。

### 19.2 仕様

- `slnmix.config.json` のトップレベルに `"kind": "solution" | "generic"`(省略時 `solution`)。`generic` では引数なし(またはディレクトリ指定)の `npx slnmix` が `.sln` / `.vbproj` を探さず、`extraRoots` に宣言されたディレクトリだけでパックする(`targetResolver.ts` が `{ kind: "generic", rootDir }` を返す)。`target` があれば警告して無視。`extraRoots` が空なら警告し、CLI はエラーで止める
- ルートは設定ファイルの場所に固定。`--root`(設定の場所と異なる値)・`--legacy-paths` はエラー、`--include-designer` / `--include-designer-file` は警告して無視。`.sln` / `.vbproj` を引数で明示したときは `kind` に関わらず従来どおり(警告を 1 行)
- 出力(`repomixExporter.ts` の `layout: "generic"`): ヘッダー 1 行目を「slnmix.config.json(extraRoots)に宣言されたディレクトリに基づき」に、`<purpose>` を「ルートからの相対物理パスに基づく(論理構成は使っていない)」に変え、Visual Studio / Link / EmbeddedResource / Designer の注記を外す。`extraRoots` の注記は「宣言されていないディレクトリは含まれない」。`solution` の出力はバイト単位で従来と同一(HEAD ビルドとの比較で確認済み: solution / hybrid / nested-root / sdk-style / basic)
- 手順文 v7(`assets/procedure.ts`): `RenderProcedureOptions.layout`。`{{LAYOUT:NOTE | STACK | READ_UI_SUMMARY | READ_NEW_FILES | ASK_EXAMPLES | TYPE_RULE}}` の 6 箇所と、「自己検証」の VB 固有 4 行(generic では「生成コードを変更していない」「新規ファイルは create で出している」の 2 行)、「自動テスト」の置き場 2 行(generic では「既存のテストに合わせる」)を差し替える。先頭行は `(mode: full, layout: generic)`。`--print-procedure` はカレント(または `--root`)の設定の `kind` に従う。スナップショットは `test-fixtures/procedure/<mode>.generic.md` / `<mode>.generic.docs.tests.md`
- `--init-config`(`initConfig.ts`): 実行した場所(または `--root` / 位置引数のディレクトリ)に `slnmix.config.json` を作る。実在するディレクトリだけを `extraRoots` に書く(src / app / lib / apps / packages → `kind: "src"`、tests / test / e2e / `__tests__` → `kind: "test"`)。既存の設定は変えない(冪等)。`.sln` / `.vbproj` がある場所、ソース候補が無い場所はエラー(後者は設定例を表示)。`.sln` が見つからないときの従来のエラーにも `--init-config` の案内を 1 行足す
- `kind: "src"` の `include` 既定: `**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,json,html,md}`(`slnmixConfig.ts` の `DEFAULT_INCLUDE`)
- docs/ 連携・`--task` / `--mode` / `--plan`・自動テストの判定(`autoTests.ts`)・protocol.md の連結・`.prompt.md` の生成は無改修でそのまま効く。petari も無改修

### 19.3 未対応(意図的スコープ外)

- `.gitignore` 以外の除外設定の自動検出(`.repomixignore` は従来どおり尊重)
- `tsconfig.json` / `package.json` からのソースディレクトリ推定(原則 5。候補名の実在だけを見る)
- generic 構成での `<ui_summary>` 相当(React コンポーネントの要約など)。必要になったら別フェーズ
- 手順文の「自動テスト」の観点表(仕様書・設計書の § 参照)は generic でも共通。表の「層」列(screen / api / host)は webview2-bridge 由来だが、文書のひな型が共通のため残している

## 20. 初回セットアップの一本化(`slnmix init`、2026-10-11 追加、v0.18.0 で実装)

### 20.1 狙い

Claude Code / Codex をセキュリティ上の理由で導入できない企業でも回せる手法として外部に渡すにあたり、利用者の評価(2026-10-11)で「初回セットアップが複雑になってきた」が最大の手間に挙がった。v0.17.0 時点の初回は `npx petari init`(4 問の対話。うち `repomix.config.json` の作成は slnmix 利用者には不要)→ `npx slnmix --init-docs` → `.gitignore` に生成物 2 つを手で追記、VB.NET 以外はさらに `--init-config` を先に打つ必要があった。これを `npx slnmix init` 1 回にする。

### 20.2 仕様

- `slnmix init [<ディレクトリ>]`(`--root` でも可。既定はカレント)。位置引数の先頭が `init` のときだけサブコマンドとして扱う(`init` という名前のフォルダを入力にするときは `./init`)。実装は `src/initProject.ts`(deps 注入)
- 実行場所が最も近い `.git` の場所と異なれば、何も書かずにエラー(リポジトリ直下での実行を案内)。`.git` が無ければ実行した場所を使う
- 手順(どれも既存ファイルを変えない。何度実行しても同じ):
  1. 構成: 既存の `slnmix.config.json` があればそのまま(壊れた JSON は上書きせずエラー、対象が決まらなければ書き方を示してエラー)。無ければ、直下の `.sln` / `.vbproj`(設定は作らない。複数ならエラー)> 1 段下のフォルダに `.sln` が 1 つだけ(`{ "target": "<フォルダ>/<名前>.sln" }` を書く。複数ならエラー + 候補と例)> generic(`initConfig` と同じ。候補が無ければエラー)
  2. docs/ 連携(`initDocs` と同じ)
  3. `.gitignore` に `repomix-output.xml` / `repomix-output.prompt.md` を末尾追記(除外済みなら足さない。既存の改行コードに合わせる)
  4. 依存の petari を `require.resolve("petari/package.json")` で見つけ、`bin` を同じ node で `init --yes --no-repomix --root <ルート>` として起動。出力は空行を除いて字下げ表示。失敗時は終了コード 1 と手動のコマンドを表示(1〜3 は済んでいる)
- 終わりに日常の 2 コマンド(`npx slnmix` / `npx petari`)とコミットすべきもの(`slnmix.config.json`・`docs/`・`protocol.md`)を表示
- `--init-docs` / `--init-config` は単独でも従来どおり使える。`.sln` が見つからないエラーの案内は `npx slnmix init` に変更
- petari v0.11.0: `petari init --no-repomix`(手順 3 を省く)。slnmix の `package.json` の依存は `"petari": "^0.11.0"`(petari の公開が先。petari は Node.js 20.19 以降が必要)

### 20.3 未対応(意図的スコープ外)

- 2 段以上深い `.sln` の探索(推測になるため。`target` を書いてもらう)
- ハイブリッド構成の `extraRoots` の自動記入(web 側のディレクトリ名は構成ごとに違う。webview2-bridge の雛形は設定を同梱済み)
- `procedure.md` の雛形生成(内蔵既定文で足りる。カスタマイズは `--print-procedure`)

## 21. Copilot Chat への受け渡し(クリップボード、2026-10-11 追加、v0.19.0 で実装)

### 21.1 狙い

外部に渡せる手法にするための計画(2026-10-11)のステップ 2「1 往復の手作業を減らす」の 1 件目。毎回の受け渡しは「`.prompt.md` を開く → 全選択 → コピー → 本文に貼る → パックを添付」の 5 操作だった。これを「本文に貼る(+ 大きいときだけ添付)」にする。

### 21.2 仕様

- パック・本文用テキストを書いた後、`planHandoff`(`src/handoff.ts`)で貼るものを決める。パック全体(`assembleOutput` の結果。先頭のリマインダと末尾の `<task>` / `<procedure>` / `<instruction>` / `<docs>` / `<templates>` を含む)が `PASTE_LIMIT_CHARS` 以内ならパック全体、超えるなら本文用テキスト、本文用テキストも無ければ何もしない
- `src/clipboard.ts` の `writeClipboard` で書く。Windows は UTF-8 の一時ファイル + PowerShell `Get-Content -Raw -Encoding UTF8 | Set-Clipboard`(パスは単一引用符エスケープ、一時ファイルは必ず消す)、macOS は `pbcopy`、Linux は `xclip`(常駐するため stdout / stderr はつながない)。15 秒でタイムアウト
- 実行末尾の案内: パック全体を入れたとき「本文に貼って送信(添付は不要)」、本文用テキストを入れたとき「.xml を添付し本文に貼って送信」。`--no-clip` / `--stdout` / 失敗時は従来の案内(失敗時は警告 1 行を先に出す)
- `.prompt.md` は従来どおり書く(クリップボードが使えない環境の控え)

### 21.3 未対応(意図的スコープ外)

- パックのファイル自体をクリップボードに載せる(Explorer のファイルコピー相当)。ブラウザへの貼り付けで添付になるかはチャットサービス次第で確認できないため
- パックの場所をエクスプローラー / Finder で開く(決定ログ 2026-10-11)

## 22. ビルドエラーの受け渡し(`slnmix build`、2026-10-11 追加、v0.20.0 で実装)

### 22.1 狙い

計画のステップ 2「1 往復の手作業を減らす」の 3 件目。ビルドエラーの往復は「Visual Studio でビルド → エラー一覧を選んでコピー → 本文に貼る」で、さらに AI はパックを作った時点の内容しか知らないため、petari で書き換わった行の SEARCH を古い内容で書いて適用に失敗することがあった。`npx slnmix build` 1 回で「ビルド → 失敗なら今の周辺行付きのエラーをクリップボードへ」にする。

### 22.2 仕様

- 入力の決め方・ルートは `npx slnmix` と同じ(`resolveTarget` / `resolveRoot`)。generic 構成はエラー(プロジェクト自身のビルド・テストを使う)
- MSBuild の場所(`src/msbuildRunner.ts` の `locateMsbuild`): `--msbuild` > vswhere(`-latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe -utf8`)> `%ProgramFiles(x86)%\MSBuild\14.0` / `12.0` > `%WINDIR%\Microsoft.NET\Framework64` / `Framework\v4.0.30319`。実在するファイルだけを使う。Windows 以外は `--msbuild` 必須
- 起動: `<対象> /nologo /m /v:minimal [/p:Configuration=<--configuration>] /fl /flp:LogFile=<一時>;ErrorsOnly;Encoding=UTF-8`。コンソールの出力は利用者の端末へそのまま出し、エラーはファイルロガーから読む(コンソールのコードページに左右されない)。一時ディレクトリは必ず消す
- 解析(`src/buildErrors.ts`): MSBuild の標準のエラー形式 `origin[(location)] : [subcategory] error code : text [project]`。先頭のノード番号(`12>`)は無視し、警告は読まない、同じエラーは 1 件にまとめる。相対パスは末尾のプロジェクトの場所を基準に解決する
- 文面: 依頼文(規約どおりの changes.md で修正、抜粋が正、「│」の右側をコピー、先頭のエラーから)+ エラーごとの「ルート相対パス:行 — コード」・本文・前後 4 行の抜粋(petari の失敗レポートと同じ `│` 区切り、該当行に `>`)。先頭 20 件まで。エラーの行を取り出せず、ログに何かあるときはログの末尾 40 行を載せる。ログも空なら何もコピーせず MSBuild の出力を見るよう案内する
- 成功時は何もコピーしない(終了コード 0)。失敗時は終了コード 1
- 認証情報の伏せ字(v0.22.2 で追加。§17 2026-10-31): 抜粋・本文・ログの末尾・ファイルとして読めないエラーの発生元(パスに見える接続文字列を含む)を、パックと同じ規則で `[MASKED]` に伏せる(`--no-mask` / `--no-strict-mask` はパックと同じ)。抜粋はファイル全体を伏せた結果を元の位置に対応づけて行ごとに当てはめる(`maskLinesForDisplay`。行番号は実ファイルのまま、複数行にまたがる値も伏せる。`.vb` は VB / 汎用テキストの両方の伏せ方の範囲を伏せる)。伏せた行はファイルごとに 1 回だけ作る。伏せ方はパックと同じ(.vb は VB のソースとして、追加ディレクトリからパックに集めるファイルは汎用テキストとしても)。エラーの本文は、抜粋で伏せた値そのものと、その中の語の引用も伏せる(3 文字以上。識別子らしい語はどこでも、それ以外の語は本文の引用の中だけ。載せる抜粋の行にひとまとまりで見えている値・語は除く)。本文そのものも VB のソースとして伏せ、シグネチャの省略可能な引数の文字列の既定値は名前に関わらず伏せる(エラーのないファイルの宣言を、定数の値に置き換えた既定値ごと引用するため)。抜粋の行は単独の CR なども 1 行と数える(コンパイラーと同じ。伏せる処理はパックと同じ区切りの行にかける)。パックが `.gitignore` / `.repomixignore` で除外するファイルは抜粋を載せない(`--no-gitignore` で載せる)

### 22.3 未対応(意図的スコープ外)

- Visual Studio のエラー一覧のコピーの取り込み(版・言語で列が変わる)
- 警告の受け渡し、テストの実行(テストは `pnpm test:all` のレポートが受け持つ)
- `petari watch` が適用後に自動でビルドすること(ビルドの前に git diff で確認する運用のため)

## 23. AI チャットだけでの DB 確認(手順文 v8、2026-10-13 追加、v0.21.0 で実装)

### 23.1 狙い

エージェントが使えない環境で、テスト用 DB のデータ確認(前提データの確認、変更後の検証、不具合の切り分け)を AI チャットだけで回す(スレッド「チャットだけでテストとDB確認」の計画で「データ確認から」を選択)。AI に DB の値を推測させず、確認用の SELECT を書かせ、人が手元で 1 コマンド実行して結果を貼る。

### 23.2 仕様

- 有効にする条件: ルート直下に `docs/db/schema.md` がある(`npx ashiato schema` の既定の出力先。列・型・主キー・コメントで、行の値は含まない)。`npx slnmix` は「DB の確認: あり / なし」を表示する(v0.22.0 から「DB の確認・動作検証: …」)
- パック: `<docs>` の後・`<task>` の前に `<db_schema path="docs/db/schema.md">` として全文を入れる(認証情報マスクは文書と同じ)。先頭のリマインダに列挙する。本文用テキストには入れず、添付にあることだけを書く
- 手順文 v8: `{{DB_SECTIONS}}`(テンプレート末尾、`{{TEST_SECTIONS}}` の後)に「DB の確認(テスト用 DB)」の節。定義は `<db_schema>` から引く、DB の値が答えを左右するときは推測せず `checks/<名前>.sql` を changes.md で create(直すときは rewrite)、回答末尾に `npx ashiato query checks/<名前>.sql` を示す、SELECT だけ、各文の直前に確かめることと期待値の `-- コメント`(結果の見出しになる)、1 文 50 行まで、貼られた結果を事実として扱う、checks/ をアプリのコードに含めない。無いときは空(v7 と同一)。`--print-procedure` はプレースホルダを残す
- ashiato 側(別リポジトリ): `ashiato query` は `.sql` を文に分け、すべてが SELECT / WITH で書き込み・ロック・外部参照の語を含まないときだけ実行する(1 文でも違えば 1 文も実行せず、理由をクリップボードへ)。読み取り専用トランザクション(PostgreSQL / MySQL / Oracle)、必ずロールバックするトランザクション(SQL Server)、読み取り専用で開いた DB(SQLite)で実行し、結果を Markdown でクリップボードへ入れる
- petari は無改修(checks/*.sql は通常の create。`.vb` ではないので .vbproj 登録もない)

### 23.3 未対応(意図的スコープ外)

- slnmix から DB に接続すること(DB の資格情報を slnmix に持たせない。実行は ashiato に分ける)
- テーブル定義の自動更新(`ashiato schema` を利用者が打つ。テーブルが変わったときだけでよい)
- DB のバージョン(SQL Server 2012 で使えない関数など)の自動の伝達。必要ならタスク文で伝える

## 24. AI チャットだけでの動作検証(手順文 v9、2026-10-13 追加、v0.22.0 で実装)

### 24.1 狙い

エージェントが使えない環境で、画面やバッチの操作による DB の変化を、AI が書いた期待と照合する(計画の段 3)。AI に「何を操作して、DB がどう変わるはずか」を決まった形で書かせ、人は手順どおりに操作して Enter を押し、照合の結果を 1 回貼る。

### 24.2 仕様

- 有効にする条件: §23 と同じ(ルート直下の `docs/db/schema.md`)。手順文 v9 の `{{DB_SECTIONS}}` に「DB の確認」に続けて「動作検証(テスト用 DB)」の節が入る
- 手順文の内容: 確かめるときは `checks/<名前>.verify.md` を changes.md で create(直すときは rewrite)、回答末尾に `npx ashiato verify checks/<名前>.verify.md`。手順は `## 1. すること` の見出し、その下に操作、`期待する DB の変化:` の行、`- テーブル名: 追加 1 行 (列=値, ...)` / `- テーブル名: 更新 1 行 (列=値) → (列=値, 列-=3, 列=*, ...)` / `- テーブル名: 削除 1 行 (...)` / `- テーブル名: 変化なし`。書いていないテーブルは変わってはいけない(`- ほかのテーブル: 問わない` で緩める)。貼られた判定・違い・実際の変化・操作した人のメモを事実として扱い、NG ならコードの不具合か期待の書き違いかを判断する
- ashiato 側(別リポジトリ、ashiato 0.2.0〜): `ashiato verify` は手順ごとにテーブルを読み、手順を表示して Enter を待ち、その間の変化を `expectDbChanges` と同じ照合部品で期待と比べる(遅れて来る書き込みは 3 秒まで待つ。NG のあとは `r` で再照合、`s` で飛ばす、`q` / Ctrl+C で終わる)。最後に、OK / NG とメモの表・期待・違い・変わった行の Markdown をクリップボードへ入れる。手順ファイルが読めない・ないテーブルを書いているときは何も照合せず、直すべき点をクリップボードへ入れる。`--save-session` で変化をセッションとして保存し、`ashiato export` で Excel の証跡にできる
- petari は無改修(checks/*.verify.md は通常の create)

### 24.3 未対応(意図的スコープ外)

- 画面に出たことの照合(人がメモで伝える。画面の自動操作は自動テスト = webview2-bridge-test の受け持ち)
- 値を伏せた結果(テスト用 DB の値を Copilot に貼れない会社向け。計画書 §6 の 5 の回答待ち)
- 照合の結果を次のパックへ自動で入れること(貼る運用。計画書 §4-3 の任意項目)

## 25. slnmix と petari の統合と言語汎用化(2026-10-31 追加。2026-11-01 に M1〜M3 と言語汎用化の一部を実装、petari 0.15.0)

状態: **M1〜M3 と改名は実装済み・未公開**(2026-11-01。実装の記録は §25.10)。M4(slnmix と petari の互換パッケージ)は tazuna 0.15.0 の公開の後。ツール名は **tazuna**(2026-11-01 に利用者が決定。§25.8-1)。本章の本文は改名の前に書いたため petari と書いているが、統合したツールの名前・コマンド・設定ファイル名は tazuna(`npx tazuna pack`・`tazuna.config.json`・`.tazuna/`)と読み替える。名前は `src/brand.ts` の定数 1 か所にまとめてある。

### 25.1 狙い

利用者から見ると、1 本の流れ(パックを作る → AI に渡す → 返答を当てる → ビルドする)に 2 つの名前がある。日常の操作は `npx slnmix` / `npx slnmix build` と `npx petari` / `npx petari watch` / `npx petari undo` に分かれ、初回の `npx slnmix init` は中で `petari init` を呼んでいる。作り手の側では、同じものを 2 か所で持っている。

| 二重になっているもの | slnmix | petari |
|---|---|---|
| AI への指示 | 手順文(内蔵、v9) | 規約文(ルートに `protocol.md` として書き出す、v4)。更新には `petari init` の再実行が要る |
| 設定 | `slnmix.config.json`(リポジトリにコミット) | `.petari/config.json`(.gitignore 済み) |
| ルートの決め方 | `--root` > 上に向かって最初の `slnmix.config.json`(`.git` より上には行かない)> 入力のある場所 | `--root` > 上に向かって最初の `.git` > カレント |
| Shift_JIS の読み取り | iconv-lite(cp932) | Node の `TextDecoder("shift_jis")` + 自前の変換表 |
| クリップボード | `src/clipboard.ts`(書くだけ) | `src/infra/clipboard.ts`(読み書き。Windows の書き方は同じ) |
| テスト・ビルド | CommonJS、mocha + tsc、Node 18.11 以上 | ESM、vitest + Node のネイティブ TS、Node 20.19 以上 |

版のずれも実際に起きた(slnmix 0.22.0 は `petari ^0.11.0` のままで、`slnmix init` が 0.11.0 で規約文を書いていた。0.22.1 で解消)。統合すると、利用者は 1 つの名前だけを覚えればよく、作り手は 1 か所だけを直せばよくなる。

あわせて、VB.NET 以外でも使えるツールにする(利用者の希望、2026-10-28)。ただし言語汎用化は統合とは別の段に分ける(§25.7)。統合の段では利用者に見える挙動を変えない。

### 25.2 統合後の形

統合先は **petari** のリポジトリとパッケージ(確定)。ツール名は検討中(§25.8-1)。petari に寄せる理由:

- slnmix は `.sln` から来た名前で、言語に依存しないツールの名前としては誤解を招く
- petari はもともと言語に依存しない(VB 固有なのは .vbproj への自動登録だけ)
- 「実行時依存ゼロ」の方針を持っているのは petari 側で、導入審査の説明が一番短くなる(§25.3-3)

| 今 | 統合後 | 備考 |
|---|---|---|
| `npx slnmix init` | `npx petari init` | slnmix init の中身(構成の判定・docs/・.gitignore)と petari init の中身(.petari/config.json・.gitignore)を 1 つにする。対話なし。repomix.config.json は作らない(`petari pack` が本家 repomix の代わりになる)。`--yes` / `--no-repomix` は受け付けて無視(旧 slnmix から呼ばれるため) |
| `npx slnmix [入力] [オプション]` | `npx petari pack [入力] [オプション]` | オプションは同じ名前で全部引き継ぐ(`--task` / `--mode` / `--init-docs` / `--print-procedure` など) |
| `npx slnmix build` | `npx petari build` | 同じ |
| `npx petari` / `watch` / `undo` / `show` / `list` / `protocol` | 変わらない | 引数なしの `petari` は今までどおり「適用」 |

`pack` を既定(引数なし)にしないのは、`npx petari` が今「ダウンロードした changes.md を当てる」意味で使われているため。

slnmix のパッケージは「petari を呼ぶだけ」の互換パッケージとして残す(§25.4 の M4)。`slnmix` → `petari pack`、`slnmix init` → `petari init`、`slnmix build` → `petari build` に引数をそのまま渡し、統合を知らせる 1 行を標準エラーに出す。しばらく残したあと `npm deprecate` する。

ashiato は統合しない。DB の資格情報とドライバー(mssql / oracledb)を扱うため、信頼の境界も依存も別にしておく方がよい。

### 25.3 設計の要点

1. **規約文を内蔵にする。** 規約文(petari)と手順文(slnmix)が同じパッケージに入るので、パックの `<instruction>` は内蔵の規約文から直接作れる。`protocol.md` は手順文の `procedure.md` と同じく「置いたときだけ使う上書き」にする。これで規約文を変えても `init` の再実行が要らなくなり、版のずれが起きなくなる。既存の `protocol.md` は、1 行目の版(`<!-- petari protocol vN -->`)と本文が内蔵の第 N 版と一字一句同じなら「手を加えていない」とみなして内蔵の最新版を使い、削除してよいと 1 行案内する。違えば上書きとして使い、内蔵より古い版なら警告する(どちらも機械的な比較で、推測はしない。比べるために過去の版のハッシュを内蔵する)
2. **設定とルート。** リポジトリにコミットする設定(構成・extraRoots・target)と、PC ごとの設定(Downloads の場所・VS Code のパス・履歴の上限)は分けたままにする。前者は新しい名前の設定ファイル(ツール名に合わせる。§25.8-3。本章では仮に `petari.config.json`)とし、`slnmix.config.json` も読み続ける(両方あればエラー)。後者は `.petari/config.json` のまま。ルートは「`--root` > 上に向かって最初の設定ファイル(`.git` より上には行かない)> 上に向かって最初の `.git` > カレント」に統一する。今は設定ファイルをサブフォルダに置いた構成でだけ、パックのルート(サブフォルダ)と適用のルート(`.git` の場所)がずれ得る。統一するとパックの `<file path>` と changes.md のパスの基準が必ず一致する
3. **実行時依存ゼロを守る(確定)。** slnmix の 3 つの依存を置き換える
   - iconv-lite → petari の `decodeFile` 系(`TextDecoder`)。パックと適用で同じデコーダーを使うことになり、AI が見る文字と petari が照合する文字が必ず同じになる。2026-10-31 に全 1 バイト・2 バイトの組(11,536 通り)で両者を比べた結果、違いは (a) 不正なバイト列での置換文字の数、(b) 0xF9 で始まる外字 187 字(iconv-lite は置換文字、TextDecoder は私用領域の文字)、(c) 1 バイトの 0x1A / 0x1C / 0x7F / 0x80 の扱い、の 3 種だけだった。普通の日本語のソースでは出力は変わらない。(b) は今「パックでは置換文字、適用では外字」とずれているので、統一でむしろ直る
   - ignore → 自前の `.gitignore` パターン照合(否定 `!`、末尾 `/`、先頭 `/`、`**`、`*`、`?`、文字クラス)。テストでは同じパターンを `git check-ignore` にもかけて結果が一致することを確かめる。git の無い場所でも動き、`.repomixignore` も今までどおり読める
   - fast-xml-parser → 自前の XML 読み取り(要素・属性・テキスト・コメント・CDATA・処理命令・実体参照)。今 vbprojParser が受け取っている形(属性は `@_` 接頭辞、名前空間の接頭辞を外す、値は文字列のまま、前後の空白を落とす)と同じ形を返し、vbprojParser 自体は変えない。壊れた XML の診断の文面だけは変わる
   - 置き換える代わりに fast-xml-parser と ignore を petari の依存に加える選択肢もある(§25.8)。その場合、導入審査の説明は「依存 9 パッケージ」(fast-xml-parser とその依存 7 つ、ignore)になる
4. **出力の互換。** 統合の段(M1〜M3)では、ツール名の行を除いてパックと本文用テキストがバイト単位で今と同じであることを完了条件にする。ツール名は「slnmix が…まとめたもの」「slnmix 出力」「`<!-- slnmix procedure v9 -->`」などで、petari に変える。利用者のリポジトリに書かれている設計書の状態行 `<!-- slnmix design: status=... -->` は文字列を変えない(利用者のファイルを書き換えずに済むように。読み取りは今の書式のまま続ける)。出力ファイル名(`repomix-output.xml` / `.prompt.md`)も変えない
5. **コードの置き場。** petari のリポジトリに `src/pack/` を作り、slnmix の構成(`services/` を含む)のまま移す。M1 では CommonJS → ESM(相対 import に `.ts`)、mocha → vitest の書き換えと、petari の厳しい型設定(`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax`)で出る型エラーの修正だけを行い、ロジックは変えない。petari の層の決まり(`core` は I/O 禁止)は今の `src/core/` にだけ効かせ、`src/pack/` は slnmix の deps 注入の書き方を続ける。コマンド層は `src/commands/pack.ts` / `build.ts`、`init.ts` は 2 つを合わせる。クリップボードは petari の `infra/clipboard.ts` に 1 本化する(Windows の書き方は既に同じ)
6. **ドキュメント。** 設計書(本書)・WORKFLOW.md・SECURITY-REVIEW.md・README は petari のリポジトリへ移し、slnmix のリポジトリには移転先を書いた README だけを残す。利用者のリポジトリの `docs/README.md`(`slnmix init` が書いたもの)は slnmix の WORKFLOW.md を指しているので、slnmix 側の WORKFLOW.md は移転先への案内として残す

### 25.4 移行の手順

着手の条件: **会社の PC での確認(Windows のクリップボード・`petari watch`・実際の MSBuild での `slnmix build`・ashiato)が終わっていること。** そこで見つかる不具合は、今の 2 つのリポジトリで直す方が早い。統合中に直すと、直した箇所を移す作業が二重になる。

| 段 | 内容 | 完了条件 |
|---|---|---|
| M1 | slnmix のコードとテスト・フィクスチャを petari の `src/pack/` へ移す(§25.3-5)。`petari pack` / `petari build` を足す。依存の置き換え(§25.3-3)もこの段 | slnmix と petari のすべてのテスト(2026-10-31 時点で 537 件と 527 件)が vitest で通る。test-fixtures の全構成で、`petari pack` の出力が slnmix 0.22.x の出力とツール名の行を除いて一致する(移行前に slnmix で出力を書き出しておき、それと比べる)。実行時依存ゼロ |
| M2 | 規約文の内蔵化(§25.3-1)、設定ファイル名とルートの統一(§25.3-2)、`petari init` の一本化 | 既存のプロジェクト(`slnmix.config.json` + 手を加えていない `protocol.md`)で `npx petari pack` の出力が M1 と同じ。`petari init` を 2 回実行しても 2 回目は何も変えない |
| M3 | ドキュメントの移転(§25.3-6)、SECURITY-REVIEW.md を 1 パッケージの説明に書き直す。petari を publish | `npm pack petari@<版>` で中身を確認(ファイル数・`src/pack` の有無) |
| M4 | slnmix を互換パッケージにして publish(依存は petari だけ)。数か月後に `npm deprecate slnmix` | `npx slnmix` / `npx slnmix init` / `npx slnmix build` が M3 の petari と同じ結果になる |

版数の目安: petari 0.15.0(M1〜M3 をまとめて出す。0.14.0 はマスクの抜けの修正で使った)、slnmix 0.23.0(M4)。

### 25.5 既存の利用者への影響

- コマンド: `npx slnmix` を `npx petari pack` に読み替えるだけ。互換パッケージがある間は `npx slnmix` のままでも動く
- ファイル: `slnmix.config.json` は名前を変えなくても読まれる(`petari init` も勝手に名前を変えない)。`protocol.md` は手を加えていなければ消してよい(消さなくても動く)。`docs/`・`.petari/`・.gitignore の行・設計書の状態行はそのまま
- 出力: ツール名の行だけが変わる。手順文の版数は変わらない(v9)
- Node.js: 20.19 以上(今も `slnmix init` が petari を起動するため、実質同じ条件)

### 25.6 導入審査の説明はどう変わるか

統合と依存の置き換えが済むと、SECURITY-REVIEW.md の主な行は次のように短くなる。

| 項目 | 今 | 統合後 |
|---|---|---|
| 入れるもの | slnmix と petari の 2 パッケージ(+ slnmix の依存 11 パッケージ) | petari の 1 パッケージだけ(実行時依存ゼロ・同梱サードパーティなし) |
| 通信・待ち受け | どちらもなし | なし |
| 起動する外部コマンド | PowerShell・pbcopy・xclip(クリップボード)、reg、git、code、MSBuild・vswhere、ブラウザの起動、`slnmix init` からの node | 同じ(`node` で petari を起動する分だけ無くなる) |

### 25.7 言語汎用化(統合の後、別の段)

統合が済んでから、1 つずつ決めて入れる。どれも統合の段には含めない。

| 今の制限 | 案 | 決めること |
|---|---|---|
| VB.NET 以外は `extraRoots` に書いたディレクトリだけが対象で、`include` の既定は Web 系の拡張子だけ(§19) | git が管理しているファイル(`git ls-files --cached --others --exclude-standard`)を既定にする。バイナリ・大きいファイル・ロックファイルは除く | 「ディレクトリを走査しない」の原則を変えることになる。git の一覧はリポジトリが宣言したものなので「推測で対象を決めない」の趣旨には合う、と考える |
| `.csproj` はスキップ | `.vbproj` と同じ読み方で対応する(Compile の既定グロブは `**/*.cs`) | Designer.cs の UI サマリーまで作るか |
| `build` は MSBuild 専用 | 設定にビルドのコマンドを書けるようにする。MSBuild 形式のエラーなら周辺行つき、それ以外は出力の末尾をコピー | エラーの形式をいくつ読むか(tsc / javac など) |
| 自動テストの判定は TS 前提(`autoTests.ts`) | 設定でテストのコマンドと置き場を宣言する | — |
| 手順文は solution / generic の 2 種 | 言語ごとの差(Option Strict・Designer など)を差し込み部品にする | — |
| .vbproj の環境(TargetFrameworkVersion・LangVersion)がパックに入らない | パックの先頭に環境の要約を入れる(VS2013 で使えない構文を避けさせる。2026-10-26 の手順文の見直しで挙げた改善候補の 1 番) | — |

### 25.8 決めること

1. **名前**: 統合先は petari のリポジトリとパッケージの続き(確定)。「ぺたり」が貼り付け(コピペ)を連想させ、検証してから書き込むという中身と逆の印象を与えるため、統合と同時に **tazuna(手綱)** に改名する(確定、2026-11-01。利用者が tazuna / handloop / kanmon / petari のままの 4 案から選んだ。npm の tazuna は同日に空きを確認)。決めたこと:
   - npm のパッケージ名・コマンド名は tazuna(版数は petari の続きの 0.15.0)。petari 0.15.0 と slnmix 0.23.0 は tazuna を呼ぶだけの互換パッケージ(petari は tazuna のリポジトリの `compat/petari/`)
   - 設定ファイルは `tazuna.config.json`(`petari.config.json` は公開前だったので読まない)と旧名の `slnmix.config.json`
   - PC ごとの設定と履歴は `.tazuna/`。`.tazuna/` が無く `.petari/` だけがあるリポジトリでは `.petari/` を使い続ける(移さない・`.tazuna/` を作らない)。PC 全体の設定も `tazuna/config.json` が無ければ `petari/config.json`
   - 規約文の 1 行目を `<!-- tazuna protocol v5 -->` に(本文は v4 と同じ。旧 init が書いた v4 は手を加えていなければ見分ける)
   - GitHub のリポジトリ名を tazuna に変える(利用者。旧 URL は GitHub が転送する)。設計書のファイル名はリンクを切らないため変えない
2. **実行時依存ゼロ**: fast-xml-parser と ignore を自前に置き換える(確定、2026-10-31)
3. **設定ファイル名**: 新しい名前の設定ファイルにし、`slnmix.config.json` も読み続ける(確定、2026-10-31。名前は 1 に従う)
4. **VB.NET 以外の既定を「git が管理しているファイル」にするか**: 統合の後で決める(確定、2026-10-31)

### 25.9 未対応(意図的スコープ外)

- ashiato の統合(§25.2)
- 出力ファイル名(`repomix-output.*`)の変更
- `petari pack` を引数なしの既定にすること(§25.2)
- `src/pack/` を petari の層(core / infra / commands)へ組み直すこと。M1 では構成を変えずに移し、必要になったら別の段で行う

### 25.10 実装の記録(2026-11-01)

利用者の依頼(2026-11-01「おすすめの統合の実装を進めますか」)で、会社の PC での確認(§25.4 の着手の条件)を待たずに着手した。確認で見つかる不具合は petari 側で直す。公開(npm publish)と Windows での確認は利用者が行う。

| 段 | やったこと | 完了条件の確かめ方 |
|---|---|---|
| M1 | slnmix の `src/` を `src/pack/`、テストを `tests/pack/`、test-fixtures を `tests/fixtures/pack/` へ移した(ESM・vitest・厳しい型設定。ロジックは変えない)。`cli.ts` は `src/commands/pack.ts` / `build.ts` / `pack-io.ts` に分けた。依存の置き換え: iconv-lite → `TextDecoder`(`core/encoding.ts` の `decodeShiftJis`。ICU が入れ替える 0x1A / 0x1C / 0x7F は元の制御文字に戻す)、ignore → `services/gitignoreMatcher.ts`(`git check-ignore` と 12 万通りで一致)、fast-xml-parser → `xmlReader.ts`(正しい XML 2 万通りで一致)。伏せる処理は `core/mask.ts` の 1 本、クリップボードは `infra/clipboard.ts` の 1 本 | slnmix 0.22.2 の出力と、test-fixtures の 10 構成 × 11 通りのオプション + docs / db / generic(343 出力)を比べ、ツール名と壊れた XML の診断の文面を除いてすべて一致。実行時依存ゼロ |
| M2 | 規約文の内蔵化(`protocol.md` は置いたときだけ使う上書き。手を加えていない旧版は過去の版のハッシュとの比較で見分けて使わず、削除してよいと案内。`--no-instruction` を追加)。設定ファイル名 `petari.config.json`(旧名も読む。両方あればエラー)。ルートの決め方をパックと適用で統一(`--root` > 上に向かって最初の設定ファイル > 最初の `.git` > 起点)。`petari init` の一本化(対話なし・冪等。`protocol.md` と `repomix.config.json` は作らない) | 既存のプロジェクト(`slnmix.config.json` + 手を加えていない `protocol.md`)で M1 の出力と 230 件一致。`petari init` の 2 回目は何も変えない |
| 言語汎用化 1 | generic 構成で `extraRoots` が無いときは、git が管理しているファイル(`git ls-files --cached --others --exclude-standard`)を対象にする(§25.8-4 は利用者が 2026-10-31 に決定)。除外: 既定の除外(node_modules / dist / build / .env など)・バイナリ(拡張子と NUL)・ロックファイル・256KB 超・.gitignore / .repomixignore・`<docs>` / `<db_schema>` に入るもの・パック自身の出力。`petari init` は git のリポジトリでは `{ "kind": "generic" }` だけを書く | `extraRoots` を書いた既存の generic 構成の出力は変わらない |
| 言語汎用化 2 | 言語ごとの伏せ方(`core/source-lexer.ts`)。TS / JS・Java・C#・Go・Python のファイルは、汎用テキストとして伏せた範囲のうち文字列・コメント・数値の中だけを伏せ、`process.env.API_KEY` のようなコードの部分は伏せない。1 行で閉じるはずの文字列が閉じない行は全体をリテラルとみなす(読み違えで値を出さない)。失敗レポートの抜粋は汎用テキストの範囲も含めて伏せる(旧 slnmix のパックから写した SEARCH 用) | ランダムに組んだソース(言語ごとに 400 通り × strict の有無)で、汎用テキストとして伏せる値を言語ごとの伏せ方でも伏せることを確かめた |
| M3 | 設計書・WORKFLOW.md・SECURITY-REVIEW.md・パックの説明(旧 slnmix の README → `docs/PACK.md`)を petari のリポジトリへ移した。SECURITY-REVIEW.md は 1 パッケージの説明に書き直した。版数 0.15.0 | 公開後に `npm pack petari@0.15.0` でファイル数と `dist/pack/` の有無を確かめる(利用者) |

設計からの変更:

- ルートの決め方の 3 段目(`.git`)は、パックでも使う(設計どおり)。このため、設定ファイルを置いていない既存のプロジェクトで `.sln` がリポジトリ直下より下にあると、`<file path>` の基準がリポジトリ直下に変わる(旧 slnmix は `.sln` のある場所)。適用のルートと一致する方向の変更で、`slnmix init` で作ったプロジェクト(直下に `.sln` か、設定の `target`)では変わらない
- `petari init` を `.git` のあるフォルダより下で打つと、止めずにリポジトリ直下(または上の設定ファイルの場所)をセットアップする(旧 slnmix init は止めた)。ルートの決め方が統一されたので、どこで打っても同じ場所になるため
- 旧 slnmix の README は、README を短く保つため `docs/PACK.md` に分けた(README からリンク)

改名(2026-11-01、§25.8-1 の決定の後):

| 段 | やったこと | 完了条件の確かめ方 |
|---|---|---|
| 改名 | `src/brand.ts` の `TOOL_NAME` を tazuna に。パッケージ名・bin・設定ファイル名・案内と失敗レポートの文面・一時ファイルの接頭辞・規約文の 1 行目(v5)。状態ディレクトリは `.petari/` だけがあればそれを使い続ける(`stateDirectoryName`)。パックの git の一覧から `.tazuna/`・`.petari/` を除く(.gitignore に書いていなくても)。`compat/petari/`(petari 0.15.0。tazuna を呼ぶだけ) | 旧版のリポジトリ(`.petari/` だけ)で適用・init・設定の読み込みが `.petari/` を使い `.tazuna/` を作らないこと、旧 init の v4 の protocol.md を見分けることをテストで確認。パックの出力は M2 の比較とツール名の行を除いて同じ |

