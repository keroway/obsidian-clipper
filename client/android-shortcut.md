# Android「Save to Obsidian」(HTTP Shortcuts)

Chrome / ニュースアプリなどの共有シートから 1 タップで Worker に POST する
Android 版の組み立て手順。

Android の Chrome はブックマークレットを「アドレスバーにブックマーク名を打って
候補から選ぶ」形でしか起動できず、共有シートからのワンタップ保存に向きません。
そこで iOS ショートカット相当の動線を、無料・OSS の
[**HTTP Shortcuts**](https://http-shortcuts.rmy.ch/)
(`ch.rmy.android.http_shortcuts`) で実現します。

> Worker 側の設定 (`client/ios-shortcut.md`) と同じ `POST /clip` を叩くだけなので、
> Worker 側は何も変更しません。

> [!note] UI 言語について
> HTTP Shortcuts のメニューは端末の言語設定に追従するため、日本語環境では
> 日本語で表示されます。以下は **英語ラベル (日本語ラベル)** の形で併記します。
> 端末を英語にしている場合は括弧内を無視してください。

## 0. 事前に控えておくもの

- Worker URL    : 例 `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`
- 共有シークレット : `wrangler secret put SHARED_SECRET` で登録したもの

## 1. アプリ導入

HTTP Shortcuts を入れる (どちらも無料・同一アプリ):

- Google Play: <https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts>
- F-Droid: <https://f-droid.org/en/packages/ch.rmy.android.http_shortcuts/>

## 2. 共有 URL を受け取る変数を作る

共有シートから渡ってきた URL を、リクエストに差し込むための変数を用意します。

1. 左上メニュー → **Variables (変数)** → 右下「+」(**Create Variable / 変数を作成**)
2. タイプ: **Static Variable (固定変数)** / 名前: `shared_url`
3. **Allow Receiving Value from Share Dialog (「共有する…」から値の受け取りを許可する)** を ON
4. その下の **Data to Receive from Sharing (共有から受信したデータ)** で
   **Text only (テキストのみ)** を選ぶ
   (URL を共有すると本文テキストとしてこの変数に入る)

## 3. ショートカット作成

ホームに戻って右下「+」→ **Create Shortcut (ショートカットを作成)**。

### Basic Request Settings (ベーシック リクエスト 設定)

- 名称              : `Save to Obsidian`
- Method (HTTP METHOD) : `POST`
- URL               : `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`

### Request Headers (リクエスト ヘッダー)

**Add Header (ヘッダーを追加)** から 2 つ追加:

| Key             | Value                    |
|-----------------|--------------------------|
| `Authorization` | `Bearer <SHARED_SECRET>` |
| `Content-Type`  | `application/json`       |

### Request Body (リクエスト ボディ)

- Request Body Type (リクエスト ボディのタイプ): **Custom Text (カスタムテキスト)** (JSON を手書きする)
- 本文に変数 `shared_url` を埋め込む (`{{...}}` は変数の挿入 UI から入れる):

```json
{"url":"{{shared_url}}","tags":["android"]}
```

> `tags` は任意。固定タグを足したいときは配列に追記する
> (例: `["android","readlater"]`)。

### Trigger & Execution Settings (トリガー＆実行の設定)

- Android 11 以降なら **Show as app shortcut on launcher
  (ランチャーにこのアプリのショートカットを表示する)** を ON にしておくと、
  Direct Share でも共有シートに「Save to Obsidian」が直接出て速い。

### (任意) Response Handling (レスポンスの取り扱い)

- 成功時にトーストを出す / レスポンスの `path` を通知に表示する、などを設定できる。
  最低限 **Toast Popup (トースト(Toast)ポップアップ)** にしておくと送信成否がその場で分かる。

## 4. 共有シートからの利用

Chrome やニュースアプリで記事を開く → 共有 → `HTTP Shortcuts`
(または Direct Share 経由で直接「Save to Obsidian」) を選ぶ → Worker に POST。

次回 Obsidian 起動時に Remotely Save が pull し、`Inbox/` にノートが現れます
(即時反映は仕様外)。

## 5. Tips

- **メモ (note) を毎回入れたい**: もう 1 つ変数を作り、タイプを
  **Prompt for Text (テキスト プロンプト)** (実行時に入力を要求) にして、本文に足す:
  ```json
  {"url":"{{shared_url}}","note":"{{user_note}}","tags":["android"]}
  ```
- **選択テキストを引用したい**: 共有元が選択範囲をテキストとして渡す場合、
  別の Static Variable (固定変数 / 共有受け取り ON) を `selection` に割り当てる。
- **失敗時の確認**: 送信が通らないときは Worker 側で `bun run tail` を流しながら
  実行するとリクエスト到達と 4xx/5xx を確認できる。
- **動作確認だけしたい**: 上の Request Body と同じ JSON を curl で再現できる:
  ```bash
  curl -X POST https://obsidian-clipper.<your-subdomain>.workers.dev/clip \
    -H "Authorization: Bearer <SHARED_SECRET>" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/article","tags":["android"]}'
  ```
