# nuro-receipt-automation

NURO光の請求確定メールをGmailで確認し、マイページから請求書PDFを取得してGoogle Driveへ保存し、「インジ販売管理」へ記帳するGitHub Actionsです。

## 処理内容

1. Gmailで件名 `【NURO 光】お支払い金額のお知らせ` の最新メールを確認
2. NURO光マイページへPlaywrightでアクセス
3. 保存済みCookie、またはGitHub SecretsのID・パスワードでログイン
4. 最新の請求書PDFをダウンロード
5. PDFから取引年月日と請求金額を抽出
6. 指定Google Driveフォルダへ保存
7. スプレッドシート「インジ販売管理」の最新行へ以下を入力

| 列 | 入力値 |
|---|---|
| A | 経費 |
| B | 請求書の取引年月日 |
| C | NURO 光 |
| D | ｿﾆｰﾈｯﾄﾜｰｸｺﾐｭﾆｹｰｼｮﾝｽﾞ㈱ |
| I | 請求金額 |
| J | 直前行から引き継いだ数式 |
| K | Drive上の請求書URL |

同じ取引年月日・金額のNURO光経費がある場合は重複登録しません。

## GitHub Actions Secrets

リポジトリの `Settings > Secrets and variables > Actions` で登録します。

必須：

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

NUROログインは、次のどちらかを設定します。

- 推奨：`NURO_STORAGE_STATE`
- 予備：`NURO_USER_ID` と `NURO_PASSWORD`

任意：

- `DISCORD_WEBHOOK`：成功・失敗通知先

## Google OAuthの初期設定

Google CloudでOAuthクライアント（デスクトップアプリ）を作り、Gmail API・Google Drive API・Google Sheets APIを有効化します。

ローカルPCで以下を実行します。

```bash
npm install
set GOOGLE_CLIENT_ID=作成したクライアントID
set GOOGLE_CLIENT_SECRET=作成したクライアントシークレット
npm run oauth
```

表示されたURLで認証し、出力された値を `GOOGLE_REFRESH_TOKEN` に登録します。

## NUROログインCookieの作成

ローカルPCで次を実行します。

```bash
npm install
npx playwright install chromium
npm run nuro-login
```

開いたブラウザでNURO光へログインし、ターミナルに戻ってEnterを押します。

現在のスクリプトは、ログイン状態のJSONをgzip圧縮してからBase64化します。ターミナルに表示された `gz:` から始まる1行の文字列全体を、GitHub Actions Secret `NURO_STORAGE_STATE` に登録してください。

例：

```text
gz:H4sIAAAAA...
```

以前の非圧縮文字列はGitHub Secretsの48KB上限を超える場合があります。必ず最新ブランチを取得して `npm run nuro-login` をやり直してください。

```bash
git pull
git checkout feature/initial-automation
npm run nuro-login
```

出力の末尾に、元サイズと圧縮後サイズが表示されます。圧縮後が48KB以下ならそのまま保存できます。

この値はログインCookieを含むため、リポジトリのファイル、Issue、チャットへ貼らないでください。

### 圧縮後も保存できない場合

圧縮後も48KBを超える場合は、GitHub公式の大容量Secret方式として、認証JSONをGPGで暗号化してリポジトリへ置き、復号パスフレーズだけをGitHub Secretへ登録する方式へ切り替えます。未暗号化のJSONは絶対にコミットしないでください。

## 実行時刻

毎日11:30（日本時間）に実行します。メールがない、または既に登録済みの場合は何も変更しません。

Actions画面の `NURO Receipt Automation > Run workflow` から手動実行もできます。最初は `dry_run` を有効にして動作確認してください。

## 注意事項

- NURO側の画面構成が変わるとセレクター修正が必要になる場合があります。
- CAPTCHA、SMS認証、追加の本人確認が出た場合は無人ログインできません。
- Cookieが失効した場合は `npm run nuro-login` を再実行してSecretを更新します。
- GitHub Actionsの実行環境は毎回作り直されます。CookieはGitHub Secretから毎回復元します。
