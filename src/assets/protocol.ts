/**
 * AI への規約文 (§4.5)。single source はこのファイル。
 * slnmix は `petari protocol` の出力を取り込み、repomix は
 * `petari protocol > protocol.md` + instructionFilePath で読み込む。
 * 内容を変更したら PROTOCOL_VERSION を上げること。
 * 制約: slnmix (v0.7.0+) はこのテキストを <instruction>...</instruction> で囲んで
 * 出力へ連結するため、規約文に <instruction> という文字列を含めないこと。
 */
export const PROTOCOL_VERSION = 2;

export const PROTOCOL_TEXT = `<!-- petari protocol v${PROTOCOL_VERSION} -->
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
   (同じコードが複数箇所にある場合は、前後の行を含めて一意にする)
4. パスはプロジェクトルートからの相対パスを / 区切りで書く。絶対パスや .. は使わない
5. 同じファイルへの変更は 1 つの FILE セクションにまとめる (セクションを重複させない)
6. FILE セクションの間に説明文を書かない。説明はすべて冒頭の CHANGES セクションに書く
7. 対象ファイルが日本語 Shift_JIS の場合、絵文字など Shift_JIS で表現できない文字を
   コード中に入れない
8. changes.md 以外の出力 (前置き・後書き) は最小限にする
`;
