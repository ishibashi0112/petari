# petari → tazuna

petari は 0.15.0 で **tazuna** に改名し、slnmix(コードベースを 1 ファイルにまとめる道具)と 1 つになりました。
このパッケージは、`npx petari ...` を `npx tazuna ...` に読み替えて呼ぶだけの互換コマンドです
(引数はそのまま。実行のたびに改名を知らせる 1 行を標準エラーに出します)。

```bash
npx tazuna            # changes.md を適用する(旧 npx petari)
npx tazuna watch      # 届いた changes.md を自動で適用する(旧 npx petari watch)
npx tazuna pack       # コードベースをまとめてチャットに渡す(旧 npx slnmix)
```

- 履歴と PC ごとの設定(`.petari/`)はそのまま使えます(tazuna は `.petari/` だけがあるリポジトリではそれを使い続けます)
- 使い方と移行の説明: https://github.com/ishibashi0112/tazuna#readme
