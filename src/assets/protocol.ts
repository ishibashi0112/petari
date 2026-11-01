import { TOOL_NAME } from "../brand.ts";

/**
 * AI への規約文 (§4.5)。single source はこのファイル。
 * tazuna pack はこれを <instruction> としてパックの末尾に連結する (設計書 §25.3-1。ルートの protocol.md は
 * 置いたときだけ使う上書き)。repomix で使うときは `tazuna protocol > protocol.md` + instructionFilePath。
 * 内容を変更したら PROTOCOL_VERSION を上げ、上げる前の版のハッシュを PAST_PROTOCOL_SHA256 に足すこと
 * (手を加えていない protocol.md を見分けるため。tests/protocol.test.ts が確かめる)。
 * 制約: パックはこのテキストを <instruction>...</instruction> で囲んで出力へ連結するため、
 * 規約文に <instruction> という文字列を含めないこと。
 */
export const PROTOCOL_VERSION = 5;

export const PROTOCOL_TEXT = `<!-- ${TOOL_NAME} protocol v${PROTOCOL_VERSION} -->
# コード変更の出力規約 (changes.md)

これは、このコンテキストを添付したユーザー本人からの恒常的な指示です。
チャット本文で個別に言及されていなくても、この会話でコードの変更を提案するときは
常に本規約を適用してください。

コードの変更を提案するときは、必ず以下の規約に従った Markdown ファイルを 1 つ出力してください。
ファイル名は changes.md とし、ダウンロードできる形で提供してください。
このファイルはツールが機械的にパースしてローカルのコードベースへ適用します。
規約から外れた出力は適用に失敗します。

## 全体構造

出力は必ず「## CHANGES」の行から始めます。

\`\`\`
## CHANGES

(変更概要 — 必須。何を・なぜ変えるかを簡潔に)

影響ファイル:
- src/utils/date.ts
- src/components/New.tsx

(処理フローが変わる場合のみ、Mermaid 図を付ける — 任意)

### FILE: src/utils/date.ts (replace)
<<<<<<< SEARCH
old code
=======
new code
>>>>>>> REPLACE

### FILE: src/components/New.tsx (create)
<<<<<<< CONTENT
(ファイル全文)
>>>>>>> END

### FILE: src/legacy/Old.vb (rewrite)
<<<<<<< CONTENT
(ファイル全文)
>>>>>>> END

### FILE: src/legacy/Unused.vb (delete)
\`\`\`

## 操作種別

- replace: 部分変更。SEARCH/REPLACE ブロックを使う。1 ファイルに複数ブロック可
- create: 新規ファイル作成。CONTENT ブロックに全文を書く。既存ファイルには使わない
- rewrite: 既存ファイルの全文置き換え。**ファイルの過半が変わる場合は replace ではなく rewrite を使う**
- delete: ファイル削除。ブロック本文は書かない
- ファイル名変更 (rename) は「旧パスの delete + 新パスの create」で表現する

## 厳守事項

1. マーカー行 (\`### FILE:\` \`<<<<<<< SEARCH\` \`=======\` \`>>>>>>> REPLACE\` \`<<<<<<< CONTENT\` \`>>>>>>> END\`) は
   必ず行頭から書き、前後に他の文字を付けない
2. SEARCH ブロックの内容は、**現在のファイルから一字一句そのまま** (インデント・空白を含めて) コピーする。
   記憶に頼って書き換えたり要約したりしない
3. SEARCH ブロックには **ファイル内で一意に特定できる範囲** を含める
   (同じコードが複数箇所にある場合は、前後の行を含めて一意にする)。
   ただし一意に特定できる範囲のうち **最小** (目安 3〜8 行) にする。大きな範囲は
   一致に失敗しやすい。ファイルの過半が変わるなら rewrite を使う
4. パスはプロジェクトルートからの相対パスを / 区切りで書く。絶対パスや .. は使わない
5. 同じファイルへの変更は 1 つの FILE セクションにまとめる (セクションを重複させない)
6. FILE セクションの間に説明文を書かない。説明はすべて冒頭の CHANGES セクションに書く
7. 対象ファイルが日本語 Shift_JIS の場合、絵文字など Shift_JIS で表現できない文字を
   コード中に入れない
8. changes.md 以外の出力 (前置き・後書き) は最小限にする

## 出力前の自己チェック

出力を確定する前に、次の 4 点を必ず確認してください。

1. 出力は「## CHANGES」の行から始まっているか
2. すべてのマーカー行が行頭にあり、綴りが正確か
   (<<<<<<< と >>>>>>> は記号 7 個 + 半角スペース + 語、区切りは = 7 個のみの行)
3. 各 SEARCH の内容は、提供された現在のファイルからの正確なコピーか
   (記憶をもとに再構成していないか)
4. 同じファイルの FILE セクションが重複していないか
`;

/**
 * 過去に内蔵していた規約文の SHA-256 (改行を LF に揃え、末尾の改行を除いた UTF-8)。
 * 旧版 (`petari init`) が書き出した protocol.md に手を加えていないかの判定に使う (設計書 §25.3-1)。
 * 値は git の履歴の src/assets/protocol.ts から求めた。v5 は 1 行目のツール名を tazuna にしただけ (本文は v4 と同じ)
 */
export const PAST_PROTOCOL_SHA256: ReadonlyArray<{ version: number; sha256: string }> = [
  { version: 1, sha256: "0efd7fc516de5c80023a2fde68af04cc697fd9d9fadf731d0c253e4dd1bd05f7" },
  { version: 2, sha256: "664657946d38c425fd4a513fd9f8d0837ed1712c0d11d9edecddb5a7ecc08492" },
  { version: 3, sha256: "0134cac4c56392a2f0e580184d1f5538b2dbb9f060534ab732b7f7fa0a7134e1" },
  { version: 4, sha256: "733c12c8fba036bf57844011a9cb78865d4de767d12feb6afd5721a774b63cb2" },
];
