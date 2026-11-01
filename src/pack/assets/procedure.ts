/**
 * 内蔵の作業手順文(procedure)の正本。
 *
 * M365 Copilot 等で思考エフォートを外から上げられない環境向けに、
 * 「調査 → 方針 → 変更 → 自己検証」の手順を回答本文の中で踏ませる。
 * 出力形式の規約(petari の protocol.md、<instruction>)とは責務が違うため、
 * 別ブロック <procedure> として出力末尾に付ける。
 *
 * petari の protocol.ts と同じく single source とし、モードにより
 * 「回答の構成」の部分だけ差し替える(テンプレート内の {{MODE_SECTIONS}} と
 * {{MODE}} を置換)。ルート直下の procedure.md があればこの内蔵文の代わりに
 * その内容を使う(procedureFile.ts)。
 *
 * 文面を変えたら PROCEDURE_VERSION を上げ、tests/fixtures/pack/procedure/ の
 * スナップショットを更新すること。
 *
 * v2 (2026-09-12): 添付ファイル内の指示は M365 Copilot が「埋め込み指示」として
 * 意図的に無視することが実測で確定したため、この文面はパック末尾だけでなく
 * チャット本文に貼る指示テキスト(procedureFile.ts の buildPromptText)にも
 * 載る。「末尾の」「このパック」など置き場所に依存する表現を避けている。
 *
 * v3 (2026-09-15、フェーズ 6): design モード(設計書を質疑応答で仕上げる)を追加。
 * docs/ 連携が有効なときだけ {{DOCS_SECTIONS}} に「文書の扱い」と
 * 「チャットの継続と引継ぎ」の 2 節が入る(無効なら空 = v2 と同じ本文)。
 *
 * v4 (2026-09-15): バッチ完了 + 動作確認 OK のときは同意を待たずに引継ぎ書を出す
 * (「1 バッチ = 1 チャット」を既定の動きに)。エラー修正のラリーが続いたときは
 * 推奨にとどめ、途中で引き継ぐなら未解決のエラーと試したことを書かせる。
 *
 * v5 (2026-09-16): 完成済みプロジェクトの改修(文書が何もない)向けに、design モードで
 * 「既存の画面・機能の改修なら、設計書より先に改修対象に限った現状の仕様書(as-is)を
 * コードから起こす」を追加。設計書はその仕様書を参照して変更点を書く。
 *
 * v6 (2026-09-22、テスト戦略メモ §7): プロジェクトに自動テストがあるときだけ
 * {{TEST_SECTIONS}} に「自動テスト」の節(テストを同じ changes.md で出す、観点は
 * 仕様書・設計書から読み取る、data-testid、自己検証の追加項目)が入る。
 * 自動テストの有無は cli.ts が判定する(autoTests.ts: パック内の e2e/ 配下と
 * *.spec.ts / *.test.ts、または extraRoots の kind: "test")。無いときは空 =
 * v5 と同じ本文(既存プロジェクトの出力を変えない)。
 *
 * v7 (2026-10-10): 構成の種類(layout)を追加。"solution"(既定。.sln / .vbproj の
 * 論理構成)では本文は v6 と同一。"generic"(slnmix.config.json の kind: "generic"。
 * VB.NET 以外のプロジェクト)では、VB 固有の記述(<ui_summary>・Designer.vb・
 * .vbproj・Option Strict・Handles 句・Shift_JIS・e2e の 3 層構成)を外すか一般的な
 * 表現に置き換える。差し替えは {{LAYOUT:...}} プレースホルダと、「自己検証」
 * 「自動テスト」の節の該当行だけ(新しい節は足さない)。
 *
 * v8 (2026-10-13、AI チャットだけでの DB 確認): ルートに docs/db/schema.md
 * (ashiato schema の出力 = テスト用 DB のテーブル定義)があるときだけ
 * {{DB_SECTIONS}} に「DB の確認」の節(確認用の SELECT を checks/*.sql で出させ、
 * ユーザーが ashiato query で実行して結果を貼る)が入る。無いときは空 =
 * v7 と同じ本文。
 *
 * v9 (2026-10-13、AI チャットだけでの動作検証): {{DB_SECTIONS}} に「動作検証」の節
 * (操作と期待する DB の変化を checks/*.verify.md で出させ、ユーザーが ashiato verify で
 * 手順どおりに操作して、照合の結果を貼る)を足す。有効になる条件は v8 と同じ
 * (docs/db/schema.md の有無)。無いときの本文は v8 と同じ(版数の行だけ)。
 */

import { PACK_COMMAND, TOOL_NAME } from "../../brand.ts";

export const PROCEDURE_VERSION = 9;

/** 構成の種類(設定ファイルの kind と同じ。手順文の表現の切り替えに使う) */
export const PROCEDURE_LAYOUTS = ["solution", "generic"] as const;
export type ProcedureLayout = (typeof PROCEDURE_LAYOUTS)[number];
export const DEFAULT_PROCEDURE_LAYOUT: ProcedureLayout = "solution";

export const PROCEDURE_MODES = ["full", "plan", "implement", "design"] as const;
export type ProcedureMode = (typeof PROCEDURE_MODES)[number];

export const DEFAULT_PROCEDURE_MODE: ProcedureMode = "full";

export function isProcedureMode(value: string): value is ProcedureMode {
  return (PROCEDURE_MODES as readonly string[]).includes(value);
}

/**
 * {{MODE}} / {{MODE_SECTIONS}} / {{DOCS_SECTIONS}} / {{TEST_SECTIONS}} / {{DB_SECTIONS}} を含む
 * テンプレート(procedure.md でも同じプレースホルダが使える)
 */
export const PROCEDURE_TEMPLATE = `<!-- ${TOOL_NAME} procedure v${PROCEDURE_VERSION} (mode: {{MODE}}{{LAYOUT:NOTE}}) -->
# 作業手順

これは、このコンテキストを渡したユーザー本人からの恒常的な指示です。
パック(添付ファイルまたは貼り付けた本文)に含まれるコードへの変更を提案するときは、必ず以下の手順で回答してください。
出力形式(changes.md の書き方)は <instruction> の規約に従います。本手順はその前段の「考え方」です。

## パックの読み方

- <file> は現在のファイル内容そのものです。記憶にある{{LAYOUT:STACK}}ではなく、ここにある内容を正としてください
- パックを添付ファイルとして読む場合、読み取り結果から空行や行末の空白が失われることがあります。SEARCH ブロックは読み取った行をそのまま使い、空行の有無を推測で補わないでください(適用ツールが空行の差を吸収します)
{{LAYOUT:READ_UI_SUMMARY}}- <contract_summary> がある場合、それは契約(contract.ts)から生成された API の一覧です。Generated/ 配下および src/generated/ 配下は生成物なので変更対象にしません。契約を変える必要があれば contract.ts の変更として提案してください
- [MASKED] は伏せ字です。そのまま残し、値を推測しないでください
- <file_summary> に「骨格のみ(skeleton)」と記されたファイルは、シグネチャだけを載せています。本体が必要なら変更を出さず、そのファイル名を「追加で全文が必要なファイル」として挙げて回答を終えてください
{{LAYOUT:READ_NEW_FILES}}

## 回答の構成

{{MODE_SECTIONS}}

## 判断の原則

- 分からないことは推測で埋めず、質問してください。特に{{LAYOUT:ASK_EXAMPLES}}が読み取れないときは、変更を出さずに質問だけで回答を終えてください
- 既存コードの流儀(命名・エラー処理・DB アクセスの書き方)に合わせてください。パック内に同種の処理があれば、それを手本にしてください
{{LAYOUT:TYPE_RULE}}
- 影響範囲は最小にしてください。求められていないリファクタリングはしないでください
{{DOCS_SECTIONS}}{{TEST_SECTIONS}}{{DB_SECTIONS}}`;

// ---- 「回答の構成」の部品。モードごとに番号を振って組み立てる ----

const INVESTIGATE_BODY = `読んだファイルと、関係するシンボル(クラス・メソッド・コントロール名)を箇条書きで挙げてください。
変更対象の処理がどこから呼ばれ、何を呼ぶかを 1〜3 行で述べてください。`;

const POLICY_BODY_COMMON = `何をどう変えるかを述べてください。検討して採らなかった案があれば理由とともに 1 行で。
リスク(既存動作への影響、未確認の前提)を挙げてください。`;

const CHANGES_BODY = `<instruction> の規約どおり changes.md を出してください。`;

const VERIFY_HEAD = `changes.md の SEARCH ブロックごとに、次を表で確認してください。
| ファイル | ブロック | パック内に全文があるか | 空行・インデント込みで逐語一致か | ファイル内で一意か |
加えて次を確認してください。
- 同じファイルへの SEARCH ブロック同士が重なっていない`;

const VERIFY_TAIL = `問題があれば changes.md を修正してから回答を確定してください。`;

/** 自己検証の確認項目のうち構成の種類で変わる行(solution は v6 と同一) */
const VERIFY_LAYOUT_LINES: Readonly<Record<ProcedureLayout, readonly string[]>> = {
  solution: [
    "- Handles 句のイベント名・コントロール名が <ui_summary> と一致している",
    "- Designer.vb / .resx / Generated / src/generated を変更していない",
    "- 新規ファイルは create で出し、.vbproj を編集していない",
    "- 日本語 Shift_JIS のファイルに、Shift_JIS で表現できない文字を入れていない",
  ],
  generic: [
    "- Generated / src/generated(生成コード)を変更していない",
    "- 新規ファイルは create で出している",
  ],
};

function verifyBody(layout: ProcedureLayout): string {
  return [VERIFY_HEAD, ...VERIFY_LAYOUT_LINES[layout], VERIFY_TAIL].join("\n");
}

/** 後方互換: solution 構成の自己検証本文(v6 と同一) */
const VERIFY_BODY = verifyBody("solution");

/**
 * 構成の種類で差し替える語句・行({{LAYOUT:<名前>}})。行ごと消える項目は
 * 末尾の改行まで含めて置換する(READ_UI_SUMMARY)。solution は v6 の文面そのまま。
 */
export const LAYOUT_TEXT: Readonly<Record<ProcedureLayout, Readonly<Record<string, string>>>> = {
  solution: {
    NOTE: "",
    STACK: "一般的な VB.NET / React のコード",
    READ_UI_SUMMARY:
      "- <ui_summary> は Designer.vb からの要約です。コントロール名・型はここから引いてください。Designer.vb 本体は変更対象にしません\n",
    READ_NEW_FILES:
      "- 新規ファイルは changes.md の create で出してください。.vbproj は編集しないでください(適用ツールが登録します)。パスは <file_summary> に示す物理パスの規則で書いてください",
    ASK_EXAMPLES: "「どのフォームか」「既存のどの処理に合わせるか」「例外時の挙動」",
    TYPE_RULE: "- Option Strict On を前提に、型変換は明示してください",
  },
  generic: {
    NOTE: ", layout: generic",
    STACK: "一般的なコード",
    READ_UI_SUMMARY: "",
    READ_NEW_FILES:
      "- 新規ファイルは changes.md の create で出してください。パスは <file_summary> に示す物理パスの規則で書いてください",
    ASK_EXAMPLES: "「どの画面・モジュールか」「既存のどの処理に合わせるか」「例外時の挙動」",
    TYPE_RULE: "- 型は明示し、暗黙の型変換や any に相当する緩い型に頼らないでください",
  },
};

const DESIGN_INVESTIGATE_BODY = `受領した資料(テーブル定義・既存画面のコード・プロトタイプ等)と、手本にする既存コードを読み、分かったことを箇条書きで挙げてください。
既存コードの流儀(SQL の書き方・ファイル構成・命名・エラー処理・監査列)のうち踏襲するものを挙げてください。
資料から読み取れないことは推測せず、次の「確認事項」に回します。`;

const DESIGN_DOC_BODY = `設計書を changes.md で出してください。初回は <template kind="design"> の章立てで docs/design/<画面名または機能名>.md を create、2 回目以降は <docs> にある現在の設計書への replace(章の大半が変わるときは rewrite)です。全文を出し直さず、変わった箇所だけを replace にしてください。
依頼が既存の画面・機能の改修(仕様追加・変更)で、その画面の仕様書が <docs> にない場合は、設計書より先に、改修対象の画面・機能に限った現状の仕様書(as-is)を <template kind="spec"> の章立てで docs/spec/<画面名>.md として同じ changes.md で create してください。パックのコードから読み取れる振る舞いだけを書き、読み取れないことは「未確認」と記します。プロジェクト全体の仕様書を一度に起こさないでください。設計書の変更点(§1-3)は、その仕様書の § を参照して「現状 → 変更後」で書いてください。
設計書の 1 行目の状態行(status / blocking / deferred)を、確認事項(§10)の未回答数と一致するように更新してください。必須の未回答が 0 件になったら status=ready にし、版(見出しの vX.Y)と更新履歴(§12)も進めてください。
コードの変更はこのモードでは出しません。`;

const DESIGN_QUESTIONS_BODY = `ユーザーに確認したいことを番号付きで挙げてください。1 件ごとに種別(必須 = 回答がないと実装に進めない / 後回し = 実装を進めながら確認期限までに回答をもらう)と、後回しなら確認期限(どのバッチの着手前か)を付けてください。
なければ「なし」と書いてください。設計書 §10 の表と同じ内容にしてください。`;

const DESIGN_CONTINUE_BODY = `次のどちらかを 1 行で書いてください。
- 「継続判定: 継続」— 必須の確認事項が残っている。回答を待って設計書を更新します
- 「継続判定: 設計確定」— 必須の確認事項が 0 件。実装は新しいチャットで始めるようユーザーに伝え、次に打つべき操作(${PACK_COMMAND} の実行 → 新しいチャットにパックを添付し本文用テキストを貼る)を案内してください
設計確定のときは、仕様書がまだなければ同じ changes.md に初版(<template kind="spec"> の §1〜§4 まで。docs/spec/<設計書と同じファイル名>.md を create)を含め、改修で既に現状の仕様書があれば変更後の振る舞いを「未」の実装状況で追記してください。
このモードでは引継ぎ書を書きません(設計書自体が次のチャットへの引継ぎになります)。`;

function section(number: number, title: string, body: string): string {
  return `### ${number}. ${title}\n${body}`;
}

function buildModeSections(layout: ProcedureLayout): Readonly<Record<ProcedureMode, string>> {
  const VERIFY_BODY = verifyBody(layout);
  return {
  full: [
    section(1, "調査", INVESTIGATE_BODY),
    section(
      2,
      "方針",
      `${POLICY_BODY_COMMON}
確認したいことがあれば、ここで質問し、変更を出さずに終えてください。`,
    ),
    section(3, "変更", CHANGES_BODY),
    section(4, "自己検証", VERIFY_BODY),
  ].join("\n\n"),
  plan: [
    section(1, "調査", INVESTIGATE_BODY),
    section(
      2,
      "方針",
      `${POLICY_BODY_COMMON}
このモードでは changes.md は出さず、方針の記述までにとどめてください。`,
    ),
    section(
      3,
      "質問",
      `曖昧な点・確認したい点を番号付きで挙げてください。なければ「なし」と書いてください。
このモードでは changes.md を出さないでください。`,
    ),
  ].join("\n\n"),
  implement: [
    section(
      1,
      "方針の確認",
      `<plan> の内容を 3 行以内で要約し、そのとおりに実装することを述べてください。<plan> と矛盾する事実をパック内に見つけた場合は、実装せずにその点を指摘して終えてください。`,
    ),
    section(2, "変更", CHANGES_BODY),
    section(3, "自己検証", VERIFY_BODY),
  ].join("\n\n"),
  design: [
    section(1, "調査", DESIGN_INVESTIGATE_BODY),
    section(2, "設計書", DESIGN_DOC_BODY),
    section(3, "確認事項", DESIGN_QUESTIONS_BODY),
    section(4, "継続判定", DESIGN_CONTINUE_BODY),
  ].join("\n\n"),
  };
}

/** 構成の種類ごとの「回答の構成」(generic は自己検証の VB 固有行だけが違う) */
export const MODE_SECTIONS_BY_LAYOUT: Readonly<
  Record<ProcedureLayout, Readonly<Record<ProcedureMode, string>>>
> = {
  solution: buildModeSections("solution"),
  generic: buildModeSections("generic"),
};

/** 後方互換: solution 構成の「回答の構成」(v6 と同一) */
export const MODE_SECTIONS = MODE_SECTIONS_BY_LAYOUT.solution;

/**
 * docs/ 連携が有効なときだけ手順文の末尾に付く 2 節。
 * 文書の役割と更新規則、チャット切り替えの客観的な引き金を AI に与える。
 * トークン残量は AI 自身に測れないため、会話の中で数えられる事象を条件にする。
 */
export const DOCS_SECTIONS = `
## 文書(docs/)の扱い

- <docs> にはプロジェクトの文書があります。kind="design" は設計書(開発の進め方と判断の根拠)、kind="spec" は仕様書(実装済みの振る舞いの正本)、kind="handoff" は引継ぎ書(前のチャットからの申し送り)です
- 引継ぎ書があれば、最初にその「0. 次のチャットで最初にやること」に従ってください
- 設計書と仕様書が食い違うときは仕様書を正としてください。意図的に設計から外れるときは、仕様書の「設計からの意図的な逸脱」に理由を残してください
- 文書の更新も changes.md で出してください(パスは <doc> の path 属性)。小さな更新は replace、章の大半が変わるときは rewrite です。文書では \`===\` や \`---\` の下線による見出し(setext 形式)を使わず、必ず \`#\` 形式にしてください(適用ツールの区切りマーカーと衝突します)
- 設計書の確認事項には 2 種類あります。「必須」は回答がないと実装に進めないもの、「後回し」は実装を進めながら確認期限(バッチ)までに回答をもらえばよいものです。バッチに着手する前に、確認期限がそのバッチ以前の「後回し」で未回答のものがないか設計書 §10 で確認し、あれば先に質問してください
- 各バッチの完了時(ユーザーの動作確認が取れたとき)に、仕様書を実装した振る舞いに合わせて更新してください(該当機能の実装状況・処理フロー・逸脱・更新履歴)
- <template> は文書のひな型です。文書を新しく作るときはこの章立てに従い、該当しない章は消さず「該当なし」と書いてください。ひな型内の HTML コメント(記入指示)は完成した文書に残さないでください

## チャットの継続と引継ぎ

- すべての回答の末尾に「継続判定: 継続」「継続判定: 引継ぎ推奨(理由)」「継続判定: 引継ぎ」のいずれかを 1 行付けてください(design モードでは「設計確定」が「引継ぎ」に相当し、引継ぎ書は書きません)
- 「引継ぎ」(同意を待たない): 実装バッチが 1 つ完了し、ユーザーがビルドと動作確認の成功を伝えたら、その回答で次を行ってください
  1. 仕様書を実装した振る舞いに合わせて更新し、引継ぎ書(<docs> の kind="handoff" の path。なければ docs/HANDOFF.md)を rewrite(初回は create)する changes.md を出す(コードの変更は含めない)
  2. 「適用ツールで適用 → ${PACK_COMMAND} を再実行 → 新しいチャットにパックを添付し本文用テキストを貼る」と案内する
  ユーザーが「このチャットで続ける」と言ったときだけ続行してください
- 「引継ぎ推奨」(同意を待つ): 次のいずれかに該当したら理由を添えて勧め、ユーザーの返事を待ってください
  1. このチャットで changes.md を 3 回以上出した(ビルドエラー・実行エラーの修正を含む。同じ問題に 2 回以上失敗しているなら、失敗した試行が残るこのチャットより、修正途中のコードを含む最新のパックで始め直す方が早い)
  2. 適用ツールの失敗レポートを 2 回受け取った(手元のコードとパックがずれている兆候)
  3. ユーザーがパックを添付し直した
- バッチの途中で引き継ぐときは、引継ぎ書の「到達点」を「着手中」にし、「未解決のエラーと試したこと」に、エラーの内容・試して効かなかった修正・まだ試していない案を書いてください(次のチャットが同じ試行を繰り返さないためです)
- 引継ぎ書はコードの変更と同じ changes.md に混ぜないでください(適用後の状態を書くためです)。章立ては <template kind="handoff"> に従ってください
- 引継ぎ書には規約・手順のコピーやコードの一覧を書かないでください。次のチャットにはツールが最新のパックと指示を付けます
`;

/**
 * 自動テストがあるプロジェクトでだけ手順文の末尾に付く節(v6、テスト戦略メモ §7-1)。
 * テストを同じ changes.md で出させ、観点は仕様書・設計書の決まった章から読み取らせる
 * (ユーザーにテスト要件を聞かない)。有無の判定は autoTests.ts。
 */
const TEST_LAYOUT_LINES: Readonly<Record<ProcedureLayout, string>> = {
  solution: `- テストの置き場は 3 層です。DB を触らない画面の振る舞いは e2e/screen/、契約メソッドの応答と DB 更新は e2e/api/、画面から DB までの通しは e2e/host/ に置きます。関数単位のテストは対象ファイルの隣の *.test.ts です
- 既存のテストが手本です。同じ型に合わせてください: Arrange(前提データ) / Act(操作) / Assert(確認) の 3 段、要素は data-testid で指す、前提行は testId 接頭辞を付けて自分で入れる、DB の変化は db.snapshot と db.diff で見る`,
  generic: `- テストの置き場は既存のテストに合わせてください(関数単位のテストは対象ファイルの隣の *.test.ts / *.spec.ts、画面や API の通しは既存の e2e/ 等)。新しい置き場やテスト基盤を増やさないでください
- 既存のテストが手本です。同じ型に合わせてください: Arrange(前提データ) / Act(操作) / Assert(確認) の 3 段`,
};

function buildTestSections(layout: ProcedureLayout): string {
  return `
## 自動テスト

- このプロジェクトには自動テストがあります(パック内の e2e/ 配下と *.spec.ts / *.test.ts)。コードの変更を提案するときは、変更した振る舞いに対応するテストを同じ changes.md に含めてください。テストを出さない場合は、変更の説明に理由を 1 行書いてください
${TEST_LAYOUT_LINES[layout]}
- テストの観点はユーザーに聞かず、次の文書から読み取ってください。文書に書かれていない振る舞いはテストにせず、確認事項(文書が無ければ質問)に回してください。文書が無い改修では、コードから読み取れる振る舞いだけをテストにします

| 読み取り元 | 観点 | 層 |
|---|---|---|
| 仕様書 §3-3 入力項目 / 設計書 §4-2 入力項目と検証 | 必須・桁・形式・範囲の検証と、そのエラー表示 | screen |
| 仕様書 §3-2 操作一覧 / 設計書 §4-3 操作と活性条件 | ボタン・メニューの活性条件 | screen |
| 仕様書 §4 機能一覧・§5 処理フロー / 設計書 §5 処理仕様 | 機能ごとの正常系の通し、契約メソッドごとの応答と DB 更新 | host / api |
| 仕様書 §7 業務ルール・制約 / 設計書 §3-3 キー・採番・突き合わせの規則 | ルール違反時の拒否、採番の形式 | api |
| 仕様書 §8 エラー時・0 件時 / 設計書 §8 エラー処理・0 件時の方針 | 0 件表示、失敗時のメッセージ、ロールバック | screen / api |
| 設計書 §5-3 トランザクション・排他・監査列 | 監査列の更新、二重登録の防止 | api |

- 画面に追加した要素には data-testid="<画面>-<役割>"(例: order-submit)を付けてください。テストは文言や CSS で要素を選びません
- テストは既存データに依存させず、本番データを前提にしないでください
- 自己検証に次の 2 項目を加えてください: 「変更した振る舞いにテストがあるか(ないなら理由)」「画面に追加した要素に data-testid を付けたか」
- design モードでは、設計書 §9 の各バッチの完了条件を「自動テスト」と「手動確認」に分け、自動テストは上の表で読み取った観点を e2e/<層>/<画面>.spec.ts のファイル名で挙げてください
`;
}

/** 構成の種類ごとの「自動テスト」の節 */
export const TEST_SECTIONS_BY_LAYOUT: Readonly<Record<ProcedureLayout, string>> = {
  solution: buildTestSections("solution"),
  generic: buildTestSections("generic"),
};

/** 後方互換: solution 構成の「自動テスト」の節(v6 と同一) */
export const TEST_SECTIONS = TEST_SECTIONS_BY_LAYOUT.solution;

/** ashiato schema の既定の出力先。ルートにこれがあれば DB の確認を有効にする(dbChecks.ts) */
export const DB_SCHEMA_PATH = "docs/db/schema.md";
/** 確認用 SQL の置き場(ashiato query に渡すフォルダ) */
export const DB_CHECKS_DIR = "checks";

/**
 * テスト用 DB のテーブル定義(<db_schema>)があるときだけ手順文の末尾に付く節。
 * 「DB の確認」(v8): DB の値は推測させず、確認用の SELECT を changes.md で出させる。
 * 実行するのはユーザー(ashiato query。SELECT 以外が 1 文でもあれば 1 文も実行しない)で、
 * 結果の Markdown がチャットに貼られる。
 * 「動作検証」(v9): 操作の手順と期待する DB の変化を checks/*.verify.md で出させる。
 * ユーザーが ashiato verify で手順どおりに操作し、照合の結果(OK / NG・違い・変わった行)
 * の Markdown がチャットに貼られる。書式は ashiato の verifyFile.ts が読める形に合わせる。
 */
export const DB_SECTIONS = `
## DB の確認(テスト用 DB)

- <db_schema> はテスト用 DB のテーブル定義です(列・型・主キー・コメント)。テーブル名・列名・型はここから引き、推測しないでください。SQL の書き方は冒頭に書かれた DB の種類に合わせてください。載っていないテーブルが必要なら、<db_schema> にあるテーブルと足りないテーブルをすべてカンマ区切りで並べた「npx ashiato schema --tables \"<テーブル名>,<テーブル名>\"」を示し、再実行をユーザーに依頼してください(書き出しは上書きのため、今あるテーブルも並べます)
- DB の値が答えを左右するとき(データの前提の確認、変更後の検証、不具合の原因の切り分け)は、推測で答えず、確認用の SQL を changes.md で ${DB_CHECKS_DIR}/<内容が分かる名前>.sql として create してください(同じ名前のファイルを直すときは rewrite)。回答の末尾に、ユーザーが実行するコマンドを「npx ashiato query ${DB_CHECKS_DIR}/<名前>.sql」の形で 1 行示してください。結果(Markdown)はユーザーがこのチャットに貼ります
- 書いてよいのは SELECT(WITH を含む)だけです。INSERT / UPDATE / DELETE / DDL / EXEC / SELECT ... INTO / FOR UPDATE が 1 文でもあると、1 文も実行されません。文の区切りは ; です
- 各文の直前に、その文で何を確かめるかと期待する結果を -- コメントで 1 行書いてください(例: -- 合計が明細の合計と一致しない受注(0 行なら OK))。このコメントが結果の見出しになります
- 結果は 1 文につき先頭 50 行までです。件数は COUNT(*) で、差異は「期待と違う行だけを返す」SELECT で確かめ、返す行を絞ってください
- 貼られた結果は DB の事実として扱い、結論はそこから述べてください。結果がエラーなら、エラー文から SQL を直して出し直してください
- ${DB_CHECKS_DIR}/ の SQL と手順ファイル(.verify.md)は確認用です。アプリのコードや本番の手順には含めないでください

## 動作検証(テスト用 DB)

- 画面やバッチの操作で DB がどう変わるべきかを確かめるとき(変更後の動作確認、不具合の再現)は、検証の手順を changes.md で ${DB_CHECKS_DIR}/<内容が分かる名前>.verify.md として create してください(同じ名前のファイルを直すときは rewrite)。回答の末尾に、ユーザーが実行するコマンドを「npx ashiato verify ${DB_CHECKS_DIR}/<名前>.verify.md」の形で 1 行示してください。ユーザーが手順どおりに操作し、照合の結果(Markdown)をこのチャットに貼ります
- 手順は「## 1. すること」の見出しで 1 つずつ書きます。見出しの下に、開く画面・入力する値・押すボタンを具体的に書き、続けて「期待する DB の変化:」の 1 行と、「- 」で始まる期待の行を書きます。DB を変えない手順(画面を開くだけなど)には「期待する DB の変化:」を書きません(照合せず、変化だけが記録されます)
- 期待の行は、テーブルと変化の種類ごとに 1 行です:「- テーブル名: 追加 1 行 (列=値, 列=値)」「- テーブル名: 更新 1 行 (更新前の行を特定する列=値) → (更新後の列=値, ...)」「- テーブル名: 削除 1 行 (列=値)」「- テーブル名: 変化なし」。列の値を書くときに行数を省くと 1 行です。テーブル名・列名は <db_schema> から引いてください
- 更新の → の後には、その更新で変わる列をすべて書きます。値を決められない列(更新日時など)は 列=*、増減は 列+=数 / 列-=数 と書きます。ほかの列も変わってよいときは最後に ... を書きます
- 書いていないテーブルは変わってはいけません。操作のたびに変わるログのテーブルなどがあるときは、その手順に「- ほかのテーブル: 問わない」を書きます
- 値は NULL、数値、文字列をそのまま書き、カンマや括弧を含む値は '...' で囲みます。日付だけを書くと、その日のどの時刻でも一致します
- 貼られた結果の判定(OK / NG)、期待との違い、実際の変化、操作した人のメモを事実として扱ってください。NG なら、コードの不具合か期待の書き違いかを、実際の変化から判断して答えてください。「始めていません」と返ってきたら、書かれた問題を直した手順ファイルを rewrite で出し直してください
`;

export interface RenderProcedureOptions {
  /**
   * docs/ 連携が有効か({{DOCS_SECTIONS}} に文書の扱いと引継ぎの節を入れる)。
   * "placeholder" はプレースホルダを残す(--print-procedure 用。procedure.md に
   * 残しておけば実行時に設定に応じて置換される)
   */
  docs?: boolean | "placeholder" | undefined;
  /**
   * 自動テストがあるか({{TEST_SECTIONS}} に「自動テスト」の節を入れる)。
   * "placeholder" は docs と同じくプレースホルダを残す
   */
  tests?: boolean | "placeholder" | undefined;
  /**
   * テスト用 DB のテーブル定義があるか({{DB_SECTIONS}} に「DB の確認」「動作検証」の節を入れる)。
   * "placeholder" は docs と同じくプレースホルダを残す
   */
  db?: boolean | "placeholder" | undefined;
  /**
   * 構成の種類(既定 "solution")。"generic" は VB 固有の記述を外す。
   * {{LAYOUT:...}} プレースホルダと {{MODE_SECTIONS}} / {{TEST_SECTIONS}} の
   * 中身がこれで決まる
   */
  layout?: ProcedureLayout | undefined;
}

/**
 * テンプレートの {{MODE}} / {{MODE_SECTIONS}} / {{LAYOUT:...}} / {{DOCS_SECTIONS}} /
 * {{TEST_SECTIONS}} / {{DB_SECTIONS}} をモードと設定に応じて置換する。プレースホルダが
 * なければそのまま返す(procedure.md による上書きで使う)。docs / tests / db が無効なら
 * それぞれのプレースホルダは空文字になる。
 */
export function renderProcedureTemplate(
  template: string,
  mode: ProcedureMode,
  options: RenderProcedureOptions = {},
): string {
  const layout = options.layout ?? DEFAULT_PROCEDURE_LAYOUT;
  let rendered = template
    .replaceAll("{{MODE_SECTIONS}}", MODE_SECTIONS_BY_LAYOUT[layout][mode])
    .replaceAll("{{MODE}}", mode);
  for (const [name, text] of Object.entries(LAYOUT_TEXT[layout])) {
    rendered = rendered.replaceAll(`{{LAYOUT:${name}}}`, text);
  }
  if (options.docs !== "placeholder") {
    rendered = rendered.replaceAll(
      "{{DOCS_SECTIONS}}",
      options.docs === true ? DOCS_SECTIONS : "",
    );
  }
  if (options.tests !== "placeholder") {
    rendered = rendered.replaceAll(
      "{{TEST_SECTIONS}}",
      options.tests === true ? TEST_SECTIONS_BY_LAYOUT[layout] : "",
    );
  }
  if (options.db !== "placeholder") {
    rendered = rendered.replaceAll("{{DB_SECTIONS}}", options.db === true ? DB_SECTIONS : "");
  }
  return rendered;
}

/** 内蔵既定文をモードに応じて描画する */
export function renderBuiltinProcedure(
  mode: ProcedureMode,
  options: RenderProcedureOptions = {},
): string {
  return renderProcedureTemplate(PROCEDURE_TEMPLATE, mode, options);
}
