<!-- status: ready (2026-09-22 ユーザー承認。A / B (実装) / C と確認事項 8 (slnmix のルート解決) は同日実装し、slnmix 0.16.0 と webview2-bridge 0.5.0 (gen / client / create / test) を npm 公開済み。残りは会社 PC での B の確認) -->
# 動作確認の自動化 — テスト戦略 設計メモ v0.2 (2026-09-22)

## 0. この文書の位置づけ

- 「開発のたびに会社 PC で手を動かして動作確認する」手間を、テストコードを書く感覚で
  減らすための方針書。webview2-bridge / slnmix / petari の 3 リポジトリにまたがるので、
  HANDOFF-slnmix-petari と同じく slnmix の docs/ に置く
- 読者はユーザー本人と、各リポジトリで実装にあたる Claude Code。テストの知識を前提に
  しないよう、使う用語は §2 に限る
- 結論を先に書く
  1. **専用ツールは自作しない。** Playwright Test + Vitest という既製のランナーを使い、
     自作するのは「WinForms ホストを起動して接続する部品」「DB を検証する部品」
     「結果を AI に貼れる形にする部品」の 3 つだけ
  2. **検証を 3 層に分け、DB が要る層を最小にする。** DB が要らない層は Mac や
     クラウドの Claude Code が自分で走らせる。会社 PC で打つのは 1 コマンド。
     **テストコードはすべて TypeScript。VB にテストは書かない** (v0.2 で確定)
  3. **slnmix の手順文と文書ひな型に「テストも一緒に出す」を組み込む。** M365 Copilot に
     コードとテストを同じ changes.md で出させ、petari で適用し、`pnpm test` の結果を
     貼り返す。petari は無改修
  4. **テストの観点は AI が仕様書・設計書から読み取る。** ユーザーがテスト要件を
     指定しない (v0.2 で追加。§7-0)
  5. **既存プロジェクトは崩さない。** テストの無いプロジェクトでは何も変わらない (§8)

### 前提 (変わらない制約)

| 項目 | 内容 |
|---|---|
| DB | SQL Server と Oracle が直近の主対象。ただし他の DB でも使える形にする。**テスト用の DB またはスキーマは用意できる** |
| DB への到達 | 社内ネットワークの会社 Windows PC からのみ。Mac / クラウドの Claude Code からは届かない |
| 会社 PC | Windows 11、Store / winget 不可。Node + pnpm は導入済みで **npm install は問題なく行える** (2026-09-22 確認)。Edge と WebView2 ランタイムあり |
| AI | Claude Code (Mac / クラウド。コマンドを実行できる) と M365 Copilot Chat (会社 PC。実行はできず、changes.md を返すだけ) |
| 対象 | WebView2 + React で作る新規・改修アプリ (webview2-bridge 系)。**旧 WinForms のみのプロジェクトは対象外** (会社としてテストコードを書いていないため) |
| VB 側 | **バックエンド (VB) にテストコードは書かない** (2026-09-22 確定)。VB は「テストされる側」で、テストは TS から実 exe を動かして行う |

### 調査結果 (2026-09-22。既製で何が揃っているか)

| やりたいこと | 既存の有無 | 該当するもの |
|---|---|---|
| WinForms + WebView2 の画面を自動操作 | ある | Playwright が公式対応 (CDP 接続)。Microsoft 公式は Edge WebDriver + Selenium、商用なら TestComplete |
| 操作後に DB を検証 | パターンはあるが部品は無い | Playwright のフィクスチャで DB に繋ぎ seed → 操作 → SQL 検証 → 後片付け、が定番。§5 の snapshot / diff のような汎用 npm パッケージは無い |
| AI にテストを書かせる・直させる | ある | Playwright Test Agents (v1.56 以降、planner / generator / healer)。Claude Code / VS Code 向けで、実行できるエージェントが前提 |
| 実行できないチャット AI でテストを標準成果物にし結果を貼り戻す往復 | 無い | slnmix / petari の領域。自作だが小さい |
| 4.8 + VB + WinForms + WebView2 + React の基盤にテスト内蔵の雛形 | 無い | 近いのは ASP.NET Core 版サンプル、Blazor Hybrid、Electron.NET (HANDOFF §2 で不採用) |

つまり「土台は既製、接着剤だけ自作」。

## 1. 何を自動化するか

### 1-1. 現状

1. AI が changes.md を返す → petari で適用
2. 会社 PC でビルドし、exe を起動し、画面を手で操作し、DB を SQL で覗いて確認する
3. 結果を AI に文章で伝える

2 が毎回の手作業で、しかも DB の確認は「何を見るべきか」を毎回思い出す必要がある。

### 1-2. ゴール

- 会社 PC で打つのは `pnpm test:all` の 1 つ。画面操作と DB 確認が自動で走り、結果が
  Markdown 1 枚になってクリップボードに入る (petari の失敗レポートと同じ使い勝手)
- DB を触らない検証は AI 側で完結させ、会社 PC の出番を「DB を触る検証」だけにする
- テストの書き方を 1 つの型に固定し、AI (Copilot / Claude Code) がその型でテストを
  書けるようにする。ユーザーがテストを書く必要はない (読めれば十分)
- テストの観点はユーザーが指定せず、AI が仕様書・設計書から読み取る (§7-0)
- 新規アプリでは `pnpm create webview2-bridge` の時点で仕組みが入っている

### 1-3. やらないこと

- 旧スタイル .vbproj の WinForms のみのプロジェクトへのテスト導入。ブラウザ系ツールが
  効かず、UI Automation (FlaUI 等) は壊れやすい。会社方針とも合わない
- VB 側のテストコード (xUnit 等)。契約経由で VB を呼ぶ L2 (§3) が代わりを務める
- 見た目の回帰テスト (スクリーンショット比較)。環境差で誤検知が多く、運用が続かない
- 100% の自動化。印刷・外部連携・目視が要るものは手動確認として残し、引継ぎ書に
  「自動 / 手動」を分けて記録する

## 2. この文書で使う用語 (最低限)

| 用語 | 意味 | この文書での使い方 |
|---|---|---|
| 単体テスト | 関数やクラス 1 つを、他と切り離して確かめる小さなテスト。速い | Vitest (TS) |
| E2E テスト | 実際の画面を操作して、最後まで通しで確かめるテスト。遅いが実態に近い | Playwright |
| ランナー | テストを見つけて実行し、結果を集計するプログラム | Playwright Test / Vitest |
| フィクスチャ | テストの前後に「準備」と「後片付け」をしてくれる部品。テスト本文には `page` や `db` として渡ってくる | 自作するのは主にこれ |
| Arrange / Act / Assert | テスト 1 本の型。準備 → 操作 → 確認 | すべてのテストをこの 3 段で書く |
| セレクタ | 画面の要素を指す目印。`data-testid="order-submit"` のように React 側で付ける | 見た目や文言に依存しないため壊れにくい |
| CDP | Chrome DevTools Protocol。F12 の開発者ツールがブラウザ本体と会話する仕組み。`--remote-debugging-port=9222` で起動すると PC 内の 9222 番に遠隔操作の口が開き、Playwright がそこに繋ぐ。WebView2 の中身は Edge なので同じ口が開く。localhost 限定・環境変数を付けたときだけ | L2 / L3 の接続方法 |
| レポータ | ランナーの結果を人や AI 向けの形式に出す部品 | Markdown を出してクリップボードへ |
| テストデータの分離 | テストが入れたデータを他のテストや既存データと混ぜないこと | 実行 ID の接頭辞と後片付けで実現 |

## 3. 3 層構成 (どこで・誰が・何を確かめるか)

| 層 | 確かめること | 道具 | DB | 走る場所 | 誰が走らせるか |
|---|---|---|---|---|---|
| **L1 画面ロジック** (`e2e/screen/`) | 入力検証、ボタンの活性、一覧表示、エラー表示など、画面の振る舞い | Playwright + Vite dev サーバー + MemoryTransport (モック応答) | 不要 | Mac / クラウド / 会社 PC どこでも | **Claude Code が自分で**。Copilot 開発時はユーザーが `pnpm test` |
| **L2 API 通し** (`e2e/api/`) | 実 exe の VB Impl を **契約経由で直接呼び**、応答と DB 更新が正しいか。画面は操作しない | Playwright (CDP) + `bridge` フィクスチャ + DB ヘルパ + テスト DB | **要** | 会社 PC | ユーザー (`pnpm test:e2e`)。将来はランナー (§9-3) |
| **L3 画面からの通し** (`e2e/host/`) | 実 exe + WebView2 で画面を操作し、DB が変わったことまで確かめる | Playwright (CDP) + DB ヘルパ + テスト DB | **要** | 会社 PC | ユーザー (`pnpm test:e2e`) |

L2 の仕組み: CDP で繋いだページの中でブリッジクライアント (`client.parts.search(...)`) を
`page.evaluate` から呼ぶ。apps/web の `bridge.ts` が開発ビルド時 (または
`VITE_EXPOSE_BRIDGE=1`) にクライアントを `window.__webview2Bridge` に公開する 1〜2 行だけが
アプリ側の準備。VB にテストコードは要らない。この基盤では VB は「リクエストを受けて DB と
話して返す」だけなので、契約メソッドを全部通せば手書き VB のほぼ全部を覆える。

分ける理由:

- 会社 PC でしか走らないもの (L2 / L3) を減らすほど、手動の出番が減る。React 側の
  作り込みの大半は L1 で確かめられる
- 失敗の切り分けが速い。L1 が通って L3 が落ちるなら原因は VB か DB。L2 が落ちるなら
  VB + DB、L2 が通って L3 が落ちるなら画面と契約のつなぎ
- 本数の目安: L1 は画面ごとに数本〜十数本、L2 は契約メソッドごとに 1〜3 本、L3 は
  主要シナリオ (登録・更新・削除・検索) を画面ごとに数本。L3 は遅いので増やしすぎない

VB に単体テストを書かないことで失うものは小さい。契約に載らない VB コード (ホスト Form の
数十行など) はテストされないが、この基盤の設計上そこは薄く保つ前提。

補足: Vitest は L1 の下に位置する「関数単位」のテスト (契約の zod 検証、モックハンドラ、
表示用の整形関数など) に使う。gen / client では既に使っている。React コンポーネント
単体のテスト (Testing Library) は入れない。L1 の Playwright で画面ごと確かめる方が
ユーザーにも AI にも分かりやすく、道具が 1 つ減る。

## 4. 道具の選定と理由

### 4-1. Playwright Test (L1 / L2 / L3。ブラウザ操作 + ランナー + レポート)

- **WebView2 を直接操作できる** (公式にサポート)。ホスト exe を環境変数
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 付きで起動すると
  WebView2 がデバッグ口を開くので、テスト側は `chromium.connectOverCDP("http://localhost:9222")`
  で繋ぐ。**ホストの VB は無改修**。配布する exe には環境変数を付けないので影響なし
- **ブラウザのダウンロードが不要**。Playwright は通常インストール時に専用 Chromium を
  Microsoft の配信サーバーから落とすが、この計画では使わない。L2 / L3 は WebView2
  ランタイムに繋ぐだけ。L1 は `channel: "msedge"` で会社 PC の Edge を使う (Mac / クラウド
  では Playwright 同梱の Chromium)。`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を `.npmrc` に置く
- ランナー・並列制御・リトライ・スクリーンショット・トレース・カスタムレポータが
  一式揃っている。自作する範囲が最小になる
- Playwright Test Agents (planner / generator / healer) は Claude Code のセッションで
  L1 の生成に使える。生成物は §5-4 の型に合わせる

### 4-2. Vitest (関数単位)

gen / client で使用中。apps/web と雛形にも同じ設定を置く。新しい道具ではない。

### 4-3. DB アクセスの汎用化: Knex を薄く包む

「SQL Server と Oracle が主だが他も使いたい」に対して、DB ごとにアダプタを自作するのは
保守が続かない。**Knex** (Node の SQL ビルダ兼接続層) を devDependency として使い、
その上に §5-3 の小さなヘルパを載せる。Knex が方言を吸収するので、ヘルパは DB を知らない。

| DB | Knex の client | npm ドライバ | 備考 |
|---|---|---|---|
| SQL Server | `mssql` | `tedious` | 純 JS。Knex の要件で `tedious` 直接 (npm の `mssql` パッケージは tedious のラッパーで、Knex では使われない) |
| Oracle | `oracledb` | `oracledb` 6.x | thin モード。Instant Client 不要 |
| PostgreSQL | `pg` | `pg` | 純 JS |
| MySQL / MariaDB | `mysql2` | `mysql2` | 純 JS |
| SQLite | `better-sqlite3` | `better-sqlite3` | ネイティブビルドあり。ヘルパ自身の自動テストに使う |

**Knex を選んだ理由 (2026-09-22 ユーザー質問への回答)**: 決め手は Oracle。Prisma は
Oracle 非対応 (予定なし)、Drizzle は SQL Server 対応済みだが Oracle 非対応、Kysely は
SQL Server 内蔵で Oracle はコミュニティ製 dialect のみ。SQL Server と Oracle の両方を
公式 dialect で持つのは Knex だけ (3.3.0 が 2026-06 リリース、保守継続中)。用途も違う:
Prisma / Drizzle はアプリが自分のスキーマを TS で定義して型付きクライアントを生成する
道具で、既存 DB (スキーマは VB / DBA 側) に対しテーブル名を文字列で受けて動的に
読み書きするテスト補助部品には、スキーマ取り込みと再生成の負担が過剰。ヘルパの内側に
隠すので、将来 Kysely が Oracle を公式対応したら API を変えずに差し替えられる。

ドライバは各アプリが自分の分だけ入れる (テスト部品の `peerDependencies` は optional)。
「実行時依存ゼロ」は petari の方針であり、webview2-bridge のテスト部品は
devDependency なので矛盾しない。

### 4-4. 採らなかった案

| 案 | 採らない理由 |
|---|---|
| xUnit で VB の Impl を直接テスト | VB にテストコードを書かない方針 (2026-09-22)。L2 (契約経由) が代替 |
| Cypress | WebView2 に繋げない。ブラウザ同梱で会社 PC への導入が重い |
| Selenium / Edge WebDriver | WebView2 対応はあるが Edge Driver の版合わせが要る。ランナーは別途必要 |
| FlaUI / WinAppDriver (WinForms 直接操作) | 旧 WinForms を対象外にした時点で不要。壊れやすく AI にも書きにくい |
| 自作ランナー / 自作 DB アダプタ | 既製で足りる。自作は §6-1 の 3 部品に限る |
| Prisma / Drizzle / Kysely | §4-3。Oracle と動的テーブル名 |
| ドライバ直 (mssql / oracledb / pg) + 自前アダプタ | プレースホルダ記法 (`@p` / `:p` / `$1`)、識別子の引用符、件数制限構文の方言差を自分で持つことになる |
| Docker で DB をローカルに立てる | 会社 PC に Docker を入れられない。テスト DB があるので不要 |

## 5. DB 検証の設計 (汎用の型)

### 5-1. 接続とガード

- 接続情報は環境変数 (`E2E_DB_CLIENT=mssql|oracledb|pg|...` と client ごとの接続項目)。
  `.env.e2e.local` に置き **gitignore**。雛形には `.env.e2e.example` を同梱
- **本番に向けて走らない仕組み**を必ず入れる。テスト設定に `allowedDatabases`
  (DB 名 / スキーマ名 / 接続先ホストの許可リスト) を書き、接続先がそれに一致しないと
  ランナーが起動時に止まる。テスト DB があるからこそ、この 1 行で事故を防げる
- 接続は 1 回のテスト実行で 1 つ (Playwright の worker fixture)。テストごとに繋ぎ直さない

### 5-2. テストデータの分離

- 各テストに **実行 ID** (`testId`、例 `E2E-20260921-1432-a7`) を渡す。テストが作る
  マスタや伝票のキー・名称にこの接頭辞を付ける
- 既存データに依存するテストを書かない。必要な前提行は Arrange で自分で入れる
- **後片付けはフィクスチャが自動で行う**。`db.insert` で入れた行と、`db.diff` で
  「増えた」と判定された行 (画面操作でアプリが作った行) を teardown で削除する。
  削除順は挿入の逆順 (外部キー対策)。削除できなかった行はレポートに残す
- L2 / L3 は **直列実行** (`workers: 1`)。DB を共有するので並列にしない。L1 は並列でよい

### 5-3. ヘルパ API (自作部品その 2)

テスト本文に `db` として渡る。DB 方言は知らず、Knex に委ねる。

| 関数 | 役割 |
|---|---|
| `db.query(sql, params)` | 生 SQL。読み取り用。バインドは `?` (Knex が方言に変換) |
| `db.insert(table, row)` / `db.insertMany(table, rows)` | 前提行の投入。後片付けの対象として記録する |
| `db.rows(table, where)` | 条件に合う行を取る (Knex ビルダ。AI が SQL を書かずに済む) |
| `db.snapshot(specs)` | `{ table, key: [...], where? }` の配列を受け、現在の行を控える |
| `db.diff(snapshot)` | 控えと現在を比べ、テーブルごとに `inserted / updated / deleted` を返す。`updated` は変わった列だけを `{ before, after }` で返す |
| `db.expectRow(table, where, expected)` | 1 行取って部分一致を確認する短縮形 |

`snapshot` は大きいテーブルで全行を取らないよう、`where` (通常は `testId` 接頭辞) か
「キーの最大値より後ろ」で絞る。何も指定しないと警告を出す。

### 5-4. テストの型 (これ 1 つに固定する)

L3 (画面からの通し):

```ts
import { test, expect } from "@ishibashi0112/webview2-bridge-test";

test("受注を登録すると Orders に 1 行増え、画面に採番が表示される", async ({ page, db, testId }) => {
  // Arrange: このテスト固有の前提データを入れ、変化を見たいテーブルを控える
  await db.insert("Customers", { CustomerCode: `${testId}-C1`, Name: "テスト顧客" });
  const before = await db.snapshot([{ table: "Orders", key: ["OrderNo"], where: { CustomerCode: `${testId}-C1` } }]);

  // Act: 画面を操作する (data-testid で要素を指す)
  await page.getByTestId("order-customer-code").fill(`${testId}-C1`);
  await page.getByTestId("order-submit").click();
  await expect(page.getByTestId("order-no")).toHaveText(/^ORD-/);

  // Assert: DB の変化を確かめる
  const diff = await db.diff(before);
  expect(diff.Orders.inserted).toHaveLength(1);
  expect(diff.Orders.inserted[0]).toMatchObject({ CustomerCode: `${testId}-C1`, Status: "NEW" });
});
```

L2 (API 通し。Act が画面操作ではなく契約メソッドの呼び出しになる):

```ts
test("orders.register は Orders に 1 行入れ、採番した OrderNo を返す", async ({ bridge, db, testId }) => {
  await db.insert("Customers", { CustomerCode: `${testId}-C1`, Name: "テスト顧客" });
  const before = await db.snapshot([{ table: "Orders", key: ["OrderNo"], where: { CustomerCode: `${testId}-C1` } }]);

  const res = await bridge.call("orders.register", { customerCode: `${testId}-C1`, lines: [{ partNo: "A-001", qty: 2 }] });

  expect(res.orderNo).toMatch(/^ORD-/);
  const diff = await db.diff(before);
  expect(diff.Orders.inserted).toHaveLength(1);
});
```

L1 (MemoryTransport) では `db` / `bridge` を使わず `page` だけで書く。

### 5-5. SQL Server と Oracle の差で気をつける点

| 差 | 吸収のしかた |
|---|---|
| バインド変数の記法 (`@p` / `:p`) | Knex の `?` に統一 |
| 識別子の大文字小文字 (Oracle は引用符なしだと大文字) | ヘルパはテーブル名・列名をそのまま引用符付きで渡す。Oracle のプロジェクトでは DB 上の実際の名前 (通常は大文字) で書く。雛形の README に明記 |
| 日付型 (`DATE` に時刻が入る等) | 比較は文字列にせず、`toMatchObject` で必要な列だけ見る。日付は ISO 文字列に整えてから比べる小関数をヘルパに置く |
| 採番 (IDENTITY / シーケンス) | テストは採番値を決め打ちしない。`inserted` の行から読む |
| 行数上限の書き方 (`TOP` / `FETCH FIRST`) | Knex の `.limit()` |

## 6. webview2-bridge への組み込み

### 6-1. 新パッケージ `packages/test` (npm: `@ishibashi0112/webview2-bridge-test`)

公開パッケージが gen / client / create の 3 つから 4 つになる (HANDOFF.md §10 に決定を
追記済み)。中身は自作する 3 部品 + 診断コマンド。

1. **`hostApp` / `page` / `bridge` フィクスチャ**: exe を CDP 有効で起動 (環境変数を付けて
   spawn)、`connectOverCDP` で繋ぎ、最初のページを `page` として渡し、終了時に exe を落とす。
   `WEBVIEW2_USER_DATA_FOLDER` を一時ディレクトリにして実行ごとに掃除する。
   `bridge.call(method, input)` は `page.evaluate` で `window.__webview2Bridge` を呼ぶ。
   exe のパスは `e2e.config.ts` の `hostExe` (既定 `dotnet/<App>.Host/bin/Debug/net48/<App>.Host.exe`)
2. **`db` / `testId` フィクスチャ** (§5)。Knex を包む
3. **レポータ**: Playwright のカスタムレポータ。失敗したテストごとに「テスト名 / 失敗した
   行と期待値・実際値 / 画面のスクリーンショットのパス / DB diff (attach 経由) / 後片付けの
   結果」を Markdown 1 枚 (`test-results/report.md`) にまとめ、**クリップボードにコピー**
   する (petari の `clipReportOnFailure` と同じ体験。実装も同じ OS コマンド方式)。
   Copilot に貼る前提で 120K 文字以内に切り詰める
4. **`webview2-bridge-test doctor`**: 会社 PC での前提確認を 1 コマンドにする。
   ① Playwright が入っていて Edge が見つかる ② `hostExe` を CDP 付きで起動して接続し
   ページを 1 つ取れる ③ `.env.e2e.local` の設定でテスト DB に繋がり、ガードを通り、
   1 行読める。フェーズ B の実機確認はこれを走らせるだけ

### 6-2. 雛形 `templates/myapp/` に足すもの

```text
playwright.config.ts       # アプリのルート。playwrightConfig(e2e) で projects: "screen" (L1) / "api" (L2) / "host" (L3) を展開
e2e/
  e2e.config.ts            # web (dev サーバー) / host (exe) / db (allowedDatabases、track)
  screen/customers.spec.ts # L1 の見本
  api/customers.spec.ts    # L2 の見本
  host/customers.spec.ts   # L3 の見本
  README.md                # テストの型・命名・data-testid の約束・コマンド・観点の読み取り元 (§7-0)・DB 設定
.env.e2e.example
.npmrc                     # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

(実装時の変更: `playwright.config.ts` は Playwright の慣例どおりアプリのルートに置き、
パスの基準もルートにした。api / host も dev サーバー経由で exe を動かすので、
`pnpm build:web` は不要。開発ビルドだけが `window.__webview2Bridge` を公開するため)

`package.json` の scripts:

| script | 内容 | 走る場所 |
|---|---|---|
| `test` | Vitest + Playwright "screen" (L1) | どこでも |
| `test:e2e` | Playwright "api" + "host" (L2 / L3)。前提: `dotnet build` (Debug) 済み。dev サーバーは自動起動 | 会社 PC |
| `test:all` | 上 2 つを順に。会社 PC で打つ 1 コマンド | 会社 PC |
| `test:doctor` | `webview2-bridge-test doctor` | 会社 PC |

雛形を変えるので gen はマイナー版を上げる (0.5.0)。`packages/gen/template/myapp/` は
`sync` で追従する。

### 6-3. ホスト側 (VB) は無改修

CDP は環境変数で有効になる。Release ビルドでも効くが、テストは Debug ビルドを対象に
する (`WEBVIEW2_BRIDGE_DEV_URL` と同じ扱い)。配布する exe を変えない。

### 6-4. React 側の約束

- 操作する要素・確認する要素には `data-testid` を付ける。命名は `<画面>-<役割>`
  (例 `order-submit`, `order-no`)。テストは文言や CSS で要素を選ばない
- `bridge.ts` は開発ビルド時 (`import.meta.env.DEV`) または `VITE_EXPOSE_BRIDGE=1` のとき
  クライアントを `window.__webview2Bridge` に公開する (L2 用)。本番ビルドでは公開しない
- この約束を雛形の README と slnmix の手順文 (§7-1) の両方に書く。AI が画面を作るときに
  自然に付くようにする

### 6-5. リポジトリ内の見本アプリ `apps/web` にも同じ構成を入れる

`apps/web/e2e/screen/` に L1 を数本置き、`pnpm -r test` に含める。**Claude Code で
webview2-bridge を触るときの完了条件に L1 を加える** (HANDOFF.md のコマンド節に追記)。
L2 / L3 は会社 PC の Windows 実機確認の手順 (HANDOFF.md 「Windows での実行確認」) に
`pnpm test:doctor` と `pnpm test:e2e` を足す。

## 7. slnmix / petari への組み込み (「テストを意識づける」)

Copilot は実行できないので、Copilot 開発でのテストは「Copilot が書き、ユーザーが走らせ、
結果を貼り返す」往復になる。往復を減らすため、手順文と文書ひな型でテストを標準の
成果物にする。

### 7-0. テストの観点は文書から読み取る (2026-09-22 ユーザー要望)

ユーザーはテスト要件を指定しない。AI が次の場所から観点を読み取り、テストにする。

| 読み取り元 | 観点 |
|---|---|
| 仕様書 §3-3 入力項目 / 設計書 §4-2 入力項目と検証 | 必須・桁・形式・範囲の検証と、そのエラー表示 (L1) |
| 仕様書 §3-2 操作一覧 / 設計書 §4-3 操作と活性条件 | ボタン・メニューの活性条件 (L1) |
| 仕様書 §4 機能一覧 + §5 処理フロー / 設計書 §5 処理仕様 | 機能ごとの正常系の通し (L3) と契約メソッドごとの応答・DB 更新 (L2) |
| 仕様書 §7 業務ルール・制約 / 設計書 §3-3 キー・採番・突き合わせ | ルール違反時の拒否、採番の形式 (L2) |
| 仕様書 §8 エラー時・0 件時 / 設計書 §8 エラー処理・0 件時の方針 | 0 件表示、失敗時のメッセージ、ロールバック (L1 + L2) |
| 設計書 §5-3 トランザクション・排他・監査列 | 監査列の更新、二重登録の防止 (L2) |

規則: 文書に書かれていない振る舞いはテストにせず、設計書の確認事項に回す (推測で仕様を
作らない)。文書が無い改修 (as-is 仕様書を先に起こす流れ、手順文 v5) では、起こした
仕様書から同じ表で読み取る。手順文 v6 と雛形 README にこの表を載せる。

### 7-1. 手順文 v6 (`src/assets/procedure.ts`)

- 「パックの読み方」に追加: `<file>` のうち `e2e/` 配下と `*.spec.ts` / `*.test.ts` は
  自動テスト。既存のテストは変更対象であり、手本でもある
- 「回答の構成」の **変更** に追加: 「変更した振る舞いに対応するテストを、同じ changes.md に
  含めてください。観点は仕様書・設計書から読み取ります (§7-0 の表)。DB を触らない画面の
  振る舞いは `e2e/screen/`、契約メソッドの応答と DB 更新は `e2e/api/`、画面から DB までの
  通しは `e2e/host/` です。既存テストの型 (Arrange / Act / Assert、`data-testid`、
  `testId` 接頭辞) に合わせてください。テストを出さない場合は理由を 1 行書いてください」
- **自己検証** に 2 項目追加: 「変更した振る舞いにテストがあるか (ないなら理由)」
  「画面に追加した要素に `data-testid` を付けたか」
- 「判断の原則」に追加: 「テストは既存データに依存させず、`testId` 接頭辞で前提行を
  入れてください。本番データを前提にしないでください。テストの観点はユーザーに聞かず
  文書から読み取り、文書に無い振る舞いは確認事項に回してください」
- design モード: 設計書 §9 の各バッチに「完了条件 (自動テスト / 手動確認)」を書かせる。
  自動テストは §7-0 の表で読み取った観点をファイル名 (`e2e/<層>/<画面>.spec.ts`) で挙げる
- **テストが無いプロジェクトでは求めない**: パックに上記パスのテストが 1 つも無く、
  `slnmix.config.json` にも `kind: "test"` の extraRoots が無いときは、テストに関する
  文をすべて出さない (docs 連携の `{{DOCS_SECTIONS}}` と同じ条件付き置換 `{{TEST_SECTIONS}}`)。
  旧 WinForms のみのプロジェクトはこれで自動的に対象外になる
- `PROCEDURE_VERSION = 6`、`test-fixtures/procedure/` のスナップショット更新。
  テスト無しのときの出力は v5 と同一であること (スナップショットで担保)

### 7-2. 文書ひな型 (`src/assets/docTemplates.ts`)

| 文書 | 追加 |
|---|---|
| 設計書 §9 実装バッチ計画 | 列「完了条件」を「自動テスト (ファイル名) / 手動確認 (項目)」に分ける |
| 仕様書 | 章「10. テスト」を追加 (11. 未実装・既知の制限、12. 更新履歴 に繰り下げ)。機能 (F-n) ごとに、どのテストが守っているかと、手動確認が要る項目 |
| 引継ぎ書 §7 動作確認の記録 | 「自動テスト: コマンド / 件数 / 失敗 0 件」と「手動確認: 項目と結果」を分けて書く |

`DOC_TEMPLATES_VERSION` を上げる。既存の docs/ は書き換えない (ひな型は新規作成時のみ)。

### 7-3. `slnmix.config.json`

- `extraRoots` の `kind: "test"` に既定の include (`**/*.{ts,tsx,json,md}`) を足す
  (`slnmixConfig.ts` の `DEFAULT_INCLUDE`)。雛形が生成する設定に
  `{ "path": "e2e", "kind": "test" }` を含める
- **解決 (2026-09-22 承認・実装、slnmix v0.16.0)**: ルートを「`--root` > 入力のディレクトリから
  上に向かって最初に見つかる `slnmix.config.json` の場所 (`.git` より上には行かない) >
  入力のディレクトリ」で決めるようにし、設定に `target` (ルート相対の .sln) を足した。
  雛形は `slnmix.config.json` (`target: "dotnet/MyApp.sln"`、extraRoots `web` / `contract` /
  `e2e` (kind test)) を同梱し、アプリのルートで `npx slnmix` と打つだけで動く。物理パスは
  `dotnet/MyApp.Impl/X.vb` の形になり petari のルートと一致する。`.sln` を動かす案は
  新規アプリしか直らないため不採用 (slnmix 決定ログ 2026-09-22)
- パックが 120K を超えるときは `--focus` で対象画面のテストだけを全文にする
  (既存機構。テスト固有の対応は不要)

### 7-4. 失敗レポートの往復

- フェーズ C ではレポータがクリップボードに入れる Markdown をユーザーが貼る。
  petari の失敗レポートと同じで、slnmix は無改修
- 任意 (フェーズ D): `slnmix.config.json` に `testReport: "test-results/report.md"` を
  書けるようにし、ファイルが 30 分以内の更新なら本文用テキストに `<test_report>` として
  同梱する (petari の changes.md 自動検出と同じ時間規則)。貼り忘れをなくす

### 7-5. WORKFLOW.md

- 30 秒版の「ビルド・動作確認 → 結果を AI に伝える」を
  「ビルド → `pnpm test:all` → 失敗ならクリップボードのレポートを貼る → 手動確認は
  引継ぎ書の手動項目だけ → OK と伝える」に (テストがあるプロジェクトの場合)
- 3-2 の手順 3〜5 を同様に更新。「継続判定: 引継ぎ」の条件である「ビルドと動作確認の
  成功」は「自動テストが全件成功し、手動項目も OK」と読み替える

### 7-6. petari

- フェーズ 1〜3 は **無改修**。apply の成否とテストは独立で、往復はレポータと
  クリップボードで足りる
- 任意: `petari apply` 成功時に「次: pnpm test:all」の 1 行案内 (config `nextHint`)。
  適用後にコマンドを実行する `--verify` は、非信頼入力である `.petari/config.json` から
  コマンドを走らせることになるため、`vscodeCommand` と同じ制限 (コマンド名か絶対パス、
  引数固定) を付けない限り入れない。当面は見送る

### 7-7. 旧 WinForms のみのプロジェクト

対象外で確定。§7-1 の条件付き置換により手順文にテストの節が出ないので、既存の
運用は変わらない。

### 7-8. フェーズ C の実装メモ (2026-09-22、slnmix v0.15.0)

- プレースホルダは `{{TEST_SECTIONS}}`。`PROCEDURE_TEMPLATE` の末尾 (`{{DOCS_SECTIONS}}` の
  直後) に置き、`renderProcedureTemplate` の `tests: boolean | "placeholder"` で
  `{{DOCS_SECTIONS}}` と同じ扱い (`--print-procedure` は両方を残す)。置換文は
  `TEST_SECTIONS` 定数 1 つで、§7-1 の各項目 (パックの読み方・変更・自己検証・判断の原則・
  design の完了条件) を既存の節に散らさず「## 自動テスト」の 1 節にまとめた
  (テスト無しの本文を v5 と 1 文字も変えないため。v6 で足したものはすべてこの節の中)
- 判定は `src/autoTests.ts` の純粋関数 `detectAutoTests(filePaths, extraRoots)`。
  (a) `buildRepomixOutput` が実際に出力した `<file>` の path (新設 `RepomixExportResult.filePaths`。
  除外・要約済みのものは含まない) のうち、`/` に正規化・小文字化したパスが `e2e/` で始まる
  か `/e2e/` を含むか、末尾が `.spec.ts` `.spec.tsx` `.test.ts` `.test.tsx` のものがある、
  または (b) `extraRoots` に `kind === "test"` (完全一致) がある。どちらも無ければ「なし」。
  このため cli.ts はパック本文をモード決定より先に組み立てる (`--print-prompt` でも組み立てる)
- 標準エラーの要約行に `自動テスト: あり(パック内に e2e/screen/order.spec.ts ほか 2 件 / extraRoots に kind: "test")`
  または `自動テスト: なし` を「モード:」の直後に出す
- スナップショット: 既存の `test-fixtures/procedure/<mode>.md` / `<mode>.docs.md` は版数の行だけを
  v5 → v6 に置換 (本文の diff ゼロを `git show HEAD:… | sed` との比較と、本文に「テスト」が
  含まれないことのテストで担保)。自動テストありは `<mode>.tests.md` / `<mode>.docs.tests.md` を
  4 モードすべてに追加
- ひな型 v4 (`DOC_TEMPLATES_VERSION = 4`): 設計書 §9 の表を「完了条件: 自動テスト (ファイル名)」
  「完了条件: 手動確認 (項目)」の 2 列に分割、仕様書に「10. テスト」(機能 / 層 / テストファイル /
  手動確認が要る項目) を追加し以降を 11 / 12 に繰り下げ、引継ぎ書 §7 を「自動テスト:」
  「手動確認:」の 2 行に。§7-0 の表と `TEST_SECTIONS` の表が参照する章番号は変わっていない
  (`docTemplates.test.ts` が表の参照とひな型の見出しを突き合わせる)
- `slnmixConfig.ts` の `DEFAULT_INCLUDE.test = ["**/*.{ts,tsx,json,md}"]`。雛形側の
  `{ "path": "e2e", "kind": "test" }` は webview2-bridge (フェーズ B) の担当

## 8. 既存プロジェクトを崩さない保証

| リポジトリ | 保証 | 担保 |
|---|---|---|
| webview2-bridge | テスト部品は新しい別パッケージ。既存アプリが gen を上げても `e2e/` は増えない (`create` で作る新規アプリの雛形にだけ入る)。ホストの VB は無改修 | 雛形以外の生成物に差が無いことを gen のスナップショットで確認 |
| slnmix | テスト節はパックにテストが無ければ出ない。既存プロジェクトの出力は今と同一。ひな型の変更は新規に作る文書にだけ効く | `test-fixtures/procedure/` のスナップショット (テスト無し = v5 と同一) |
| petari | 無改修 | — |
| Copilot 開発 | テストのあるプロジェクトだけで Copilot がテストを同梱する。旧 WinForms のみのプロジェクトは何も変わらない | 上記 slnmix の条件付き置換 |

## 9. 実行環境と往復の形

### 9-1. 会社 PC (Windows)

前提: Node + pnpm (済)、npm install 可 (済)、Edge と WebView2 ランタイム (済)、
テスト DB の接続情報を `.env.e2e.local` に置く。

```text
pnpm test:doctor                                     (初回だけ。3 つの前提を確認)
dotnet build dotnet/MyApp.sln                        (Debug。いつもどおり)
pnpm test:all                                        (L1 → L2 → L3。dev サーバーは自動起動)
  → 失敗があれば test-results/report.md がクリップボードに入る → Copilot に貼る
  → 全件成功なら「自動テスト OK」+ 手動項目の結果を伝える
```

### 9-2. Mac / クラウド (Claude Code)

`pnpm test` (Vitest + L1) を Claude Code が自分で走らせる。webview2-bridge 自体の改修と、
Claude Code で新規アプリを組むときは、L1 が通ることを完了条件にする。L2 / L3 は
「会社 PC で `pnpm test:all` を実行してください」と引継ぎ書に書く。

### 9-3. 任意: GitHub Actions のセルフホストランナー (フェーズ D)

会社 PC にランナーを常駐させると、ブランチを push するだけで L2 / L3 が社内 DB に対して
走り、結果を Claude Code (クラウド) が GitHub 経由で読める。往復が完全に自動になる。
ランナーが必要とするのは GitHub への outbound HTTPS だけで、DB は社内に留まる。
情シスへの確認事項は「会社 PC から GitHub へのランナー常駐接続」の 1 点。
不可なら 9-1 の手動貼り付けで運用する。

## 10. 段階計画

| フェーズ | 内容 | 完了条件 | 場所 |
|---|---|---|---|
| **A** webview2-bridge L1 | `packages/test` の骨組み (フィクスチャの型・レポータ)、`apps/web/e2e/screen/` に L1 を数本、`pnpm -r test` に組み込み | Mac / クラウドで `pnpm -r test` が通り、Claude Code が自分で回せる | webview2-bridge。**完了 (2026-09-22)**: screen 6 件が Linux で通過 |
| **B** L2 / L3 と DB ヘルパ | `hostApp` / `bridge` (CDP 起動)、`db` / `testId` (Knex。自動テストは SQLite、mssql / oracledb は会社 PC)、本番ガード、レポータ + クリップボード、`doctor`、雛形 `e2e/`、gen 0.5.0 | 実装と SQLite での自動テストは Claude Code で完了。会社 PC で `pnpm test:doctor` の 3 項目が通り、雛形アプリの `pnpm test:all` が通り、わざと落とした 1 本のレポートが Copilot に貼れる形で出る | 実装は Claude Code (**完了 2026-09-22**: Vitest 45 件、ヘッドレス Chromium を代役にした CDP 起動と契約呼び出し、tgz からの雛形検証)、**会社 PC の確認は未実施** |
| **C** slnmix | 手順文 v6、ひな型更新、`kind: "test"` 既定、WORKFLOW.md | スナップショット更新済みで `pnpm test` 通過。テスト無しの出力は v5 と同一。実プロジェクトで Copilot がコードとテストを同じ changes.md で返す | slnmix。**実装完了 (2026-09-22、v0.15.0)**。実プロジェクトでの確認は未実施 |
| **D** 任意 | `<test_report>` 自動同梱、petari の 1 行案内、セルフホストランナー | 必要になったとき | 各 |

A / B (SQLite まで) / C は Claude Code だけで完結する。B の会社 PC 確認は `pnpm test:doctor`。

## 11. 確認事項

| # | 種別 | 内容 | 状態 |
|---|---|---|---|
| 1 | 後回し | テスト DB は SQL Server と Oracle の両方にあるか。片方だけなら B の実機確認はその DB で行い、もう片方は Knex の方言差の範囲として扱う | B の会社 PC 確認前に |
| 2 | 後回し | 本番ガードの許可リストに入れる DB 名 (`.env.e2e.local` 案は承認済み) | B の会社 PC 確認前に |
| 3 | 済 | パッケージ名 `@ishibashi0112/webview2-bridge-test` | 2026-09-22 異論なし |
| 4 | 後回し | セルフホストランナー (§9-3) を情シスに相談するか | C 完了後 |
| 5 | 済 | 旧 WinForms のみのプロジェクトを対象外とする | 2026-09-22 承認 |
| 6 | 済 | VB にテストコードを書かない | 2026-09-22 確定 |
| 7 | 済 | npm install が会社 PC で可能 | 2026-09-22 確認 |
| 8 | 済 | slnmix のルート (`.sln` の場所) と雛形の配置 (`dotnet/MyApp.sln`) が噛み合わない (§7-3) | 2026-09-22 slnmix にルート解決 (`--root` / 設定ファイルの位置 / `target`) を実装、雛形に `slnmix.config.json` を同梱 |

## 12. 決定事項 (2026-09-22 承認済み)

1. 専用ツールは自作せず、Playwright Test / Vitest / Knex の上に 3 部品
   (hostApp + bridge、db、レポータ) と `doctor` だけを自作する
2. 検証は L1 (画面ロジック、DB なし) / L2 (契約経由の API 通し、DB あり) / L3 (画面からの
   通し、DB あり) の 3 層。テストコードはすべて TS で、VB にテストは書かない。
   DB が要る層は会社 PC 限定で、`pnpm test:all` の 1 コマンドにまとめる
3. DB 検証は Knex 経由で方言を吸収し、SQL Server / Oracle を実機確認、他 DB はドライバの
   追加だけで使える形にする。本番ガードと `testId` 接頭辞による分離を必須にする
4. 結果は Markdown をクリップボードに入れて AI に貼る (petari の失敗レポートと同じ体験)
5. slnmix の手順文と文書ひな型で「テストも同じ changes.md で出す」を標準にし、テストの
   観点は仕様書・設計書から AI が読み取る。テストの無いプロジェクトでは求めない。
   petari は当面無改修
6. 旧 WinForms のみのプロジェクトは対象外。既存プロジェクトの出力・生成物は変えない
