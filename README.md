# Shopee Amazon Listing MVP

Amazon商品URLを読み込み、商品情報を中間データとして保存し、翻訳・整形後にPlaywrightでShopee Seller Centreの下書き入力を補助するMVPです。

安全設計:

- Shopee APIは使わずPlaywrightでブラウザ操作します。
- 投稿ボタンは押しません。入力後に確認HTMLを生成し、Playwright Inspectorで停止します。
- CAPTCHA、2段階認証、ログイン認証、ブロック表示を検出したら自動突破せず停止します。
- Amazon情報は中間JSON/確認HTMLに保存し、人間が確認・編集する前提です。
- 食品、化粧品、医薬品、サプリ、電化製品などの規制カテゴリは警告します。

## ディレクトリ構成

```text
.
├─ config/
│  ├─ default.json
│  └─ category-rules.sample.json
├─ data/
│  ├─ input.sample.csv
│  └─ manual-products.sample.json
├─ src/
│  ├─ amazon/productSource.js
│  ├─ extraction/attributeExtractor.js
│  ├─ shopee/automation.js
│  ├─ shopee/selectors.js
│  ├─ ui/reviewPage.js
│  ├─ config.js
│  ├─ csv.js
│  ├─ formatter.js
│  ├─ logger.js
│  ├─ main.js
│  ├─ translator.js
│  └─ utils.js
├─ .env.sample
├─ package.json
└─ README.md
```

## セットアップ

```powershell
npm install
Copy-Item .env.sample .env
npm run install:browsers
```

`.env` を編集します。

- `SHOPEE_SELLER_URL`: 対象国のSeller Centre新規商品URL
- `TARGET_LANGUAGE`: `en` または `zh`
- `AMAZON_SOURCE`: 本番では `paapi` または `manual-json` 推奨。MVP確認では `playwright` も利用可能
- `SHOPEE_UPLOAD_IMAGES`: 画像アップロードを試す場合は `true`

## 実行

```powershell
npm start -- --csv ./data/input.sample.csv
```

単一URL:

```powershell
npm start -- --url "https://www.amazon.com/dp/XXXXXXXXXX"
```

確認HTMLと中間JSONは `output/`、ログとエラー時スクリーンショットは `logs/` に保存されます。

## 処理フロー

1. CSVまたはURL引数からAmazon URLを読む
2. Amazon Product Advertising API、手動JSON、またはPlaywright fallbackで商品情報を取得
3. Shopee用にタイトル、説明、価格、在庫、属性候補を整形
4. 翻訳アダプタで英語または中国語へ変換
5. 入力前レビューHTMLを生成して人間確認
6. Shopee Seller Centreを永続プロファイルで開く
7. ログイン、CAPTCHA、2FAが出た場合は停止
8. 商品名と画像を入力
9. Shopeeのカテゴリ候補を取得
10. 候補が1つなら選択、複数ならCLIで人間選択
11. カテゴリ選択後の属性欄を検出して分かる範囲だけ入力
12. 入力済み、未入力、要確認、警告をHTMLとログへ保存
13. 投稿ボタン直前で `page.pause()` し、人間確認へ渡す

## エラー時の対処

- `logs/run-*.log` を確認してください。
- エラー発生時のスクリーンショットは `logs/screenshots/` に保存されます。
- Shopee画面のボタンや入力欄が見つからない場合は `src/shopee/selectors.js` の候補セレクタを追加してください。
- CAPTCHA、2FA、ログイン画面で停止した場合は手動で対応後、再実行してください。自動突破は実装していません。
- Amazon取得が不安定な場合は `AMAZON_SOURCE=manual-json` または公式PA-API実装へ切り替えてください。

## 拡張設計

- 翻訳: `src/translator.js` の `Translator` を外部API実装へ差し替え
- Amazon取得: `src/amazon/productSource.js` にPA-API実装を追加
- カテゴリ別ルール: `config/category-rules.sample.json` と同形式でJSONを追加
- Shopee UI変更: `src/shopee/selectors.js` のセレクタ候補を編集
- 属性抽出: `src/extraction/attributeExtractor.js` にカテゴリ別抽出ロジックを追加

注意: Amazonの商品画像・説明文・仕様の転載には規約や著作権の問題があり得ます。このMVPは確認・編集前提の下書き補助ツールです。運用前にAmazon、Shopee、対象国の法規制を確認してください。
