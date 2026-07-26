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

## 6. 応用: テキスト/Markdown クリップ (ADR 0011)

URL を持たないメモや他アプリのテキスト共有を保存したい場合は、別のショートカット
「Save Text to Obsidian」を同様に作る。

1. **共有受け取り用の変数を追加**: 手順 2 と同様に Static Variable を作成し、
   名前は `shared_text`、**Allow Receiving Value from Share Dialog** を ON、
   **Data to Receive from Sharing** は **Text only** のまま。
2. **Basic Request Settings**: Method `POST`、URL は同じ Worker URL。
3. **Request Headers**: `Authorization` / `Content-Type: application/json` は
   URL クリップと同じ。
4. **Request Body** (Custom Text) — **`url` キーは入れない**こと
   (入れると URL クリップとして扱われる):
   ```json
   {"text":"{{shared_text}}","tags":["android"]}
   ```
   他アプリの Markdown 共有を保存したい場合はキー名を `markdown` にする。

Worker は `url` が無く `text`/`markdown` があるボディをテキストクリップと判定し、
`source: text-clip` frontmatter 付きノートとして `Inbox/` に保存する
(要約・自動タグ・重複検知の対象外)。

## 7. 応用: 画像クリップ (ADR 0011)

写真アプリやスクリーンショットの共有シートから画像を送りたい場合は、
JSON ではなく **multipart/form-data** で送る別のショートカット
「Save Image to Obsidian」を作る。

1. **共有受け取り用の変数**: Static Variable を作成し、名前は `shared_image`、
   **Allow Receiving Value from Share Dialog** を ON、
   **Data to Receive from Sharing** は **Files (ファイル)** を選ぶ。
2. **Basic Request Settings**: Method `POST`、URL は同じ Worker URL。
3. **Request Headers**: `Authorization: Bearer <SHARED_SECRET>` のみ追加する。
   **`Content-Type` は手動で設定しない**こと
   (multipart 送信時に境界文字列込みでアプリが自動設定するため)。
4. **Request Body Type**: **File / Multipart (ファイル/マルチパート)** を選び、
   以下のパートを追加する:

   | パート名 | 種別 | 値 |
   |----------|------|-----|
   | `image`  | ファイル | 変数 `shared_image` |
   | `title`  | テキスト | (任意) |
   | `note`   | テキスト | (任意) |
   | `embed`  | テキスト | `1` (画像を埋め込んだノートも `Inbox/` に生成したい場合のみ。省略時は画像のみ保存) |

対応形式は PNG/JPEG/GIF/WEBP のみ (`415` で拒否される形式あり)。上限は
`MAX_IMAGE_BYTES` (既定 10 MiB、超過は `413`)。画像は `Attachments/` に保存され、
`embed=1` のときだけ `![[...]]` で埋め込んだ companion ノートが `Inbox/` にも作られる。
