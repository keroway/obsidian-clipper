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

## 0. 事前に控えておくもの

- Worker URL    : 例 `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`
- 共有シークレット : `wrangler secret put SHARED_SECRET` で登録したもの

## 1. アプリ導入

HTTP Shortcuts を入れる (どちらも無料・同一アプリ):

- Google Play: <https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts>
- F-Droid: <https://f-droid.org/en/packages/ch.rmy.android.http_shortcuts/>

## 2. 共有 URL を受け取る変数を作る

共有シートから渡ってきた URL を、リクエストに差し込むための変数を用意します。

1. 左上メニュー → `Variables` → 右下「+」
2. タイプ: **Static** / 名前: `shared_url`
3. **「Allow Receiving Value from Share Dialog」を ON**
4. 受け取る部分の選択肢で **「Text」** を選ぶ
   (URL を共有すると本文テキストとしてこの変数に入る)

## 3. ショートカット作成

ホームに戻って右下「+」→「Create Shortcut」。

### Basic Request Settings

- 名称   : `Save to Obsidian`
- Method : `POST`
- URL    : `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`

### Request Headers

| Key             | Value                    |
|-----------------|--------------------------|
| `Authorization` | `Bearer <SHARED_SECRET>` |
| `Content-Type`  | `application/json`       |

### Request Body

- Content Type: `Custom text` (JSON を手書きする)
- 本文に変数 `shared_url` を埋め込む (`{{...}}` は変数の挿入 UI から入れる):

```json
{"url":"{{shared_url}}","tags":["android"]}
```

> `tags` は任意。固定タグを足したいときは配列に追記する
> (例: `["android","readlater"]`)。

### Trigger & Execution Settings

- Android 11 以降なら **「Direct Share target」を ON** にしておくと、
  共有シートに「Save to Obsidian」が直接出て速い。

### (任意) Response Handling

- 成功時にトーストを出す / レスポンスの `path` を通知に表示する、などを設定できる。
  最低限「Toast」にしておくと送信成否がその場で分かる。

## 4. 共有シートからの利用

Chrome やニュースアプリで記事を開く → 共有 → `HTTP Shortcuts`
(または Direct Share 経由で直接「Save to Obsidian」) を選ぶ → Worker に POST。

次回 Obsidian 起動時に Remotely Save が pull し、`Inbox/` にノートが現れます
(即時反映は仕様外)。

## 5. Tips

- **メモ (note) を毎回入れたい**: もう 1 つ変数を作り、タイプを **prompt**
  (実行時に入力を要求) にして、本文に足す:
  ```json
  {"url":"{{shared_url}}","note":"{{user_note}}","tags":["android"]}
  ```
- **選択テキストを引用したい**: 共有元が選択範囲をテキストとして渡す場合、
  別の Static 変数 (Share Dialog 受け取り ON) を `selection` に割り当てる。
- **失敗時の確認**: 送信が通らないときは Worker 側で `bun run tail` を流しながら
  実行するとリクエスト到達と 4xx/5xx を確認できる。
- **動作確認だけしたい**: 上の Request Body と同じ JSON を curl で再現できる:
  ```bash
  curl -X POST https://obsidian-clipper.<your-subdomain>.workers.dev/clip \
    -H "Authorization: Bearer <SHARED_SECRET>" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/article","tags":["android"]}'
  ```
