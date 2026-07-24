# iOS ショートカット「Save to Obsidian」

X / Safari / その他アプリの共有シートから 1 タップで Worker に POST する
ショートカットの組み立て手順。ショートカットファイルそのものは配布できないので
手動で組む必要があります(慣れれば 5 分)。

## 0. 事前に控えておくもの

- Worker URL    : 例 `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`
- 共有シークレット : `wrangler secret put SHARED_SECRET` で登録したもの

## 1. ショートカット作成

`ショートカット.app` → 右上「+」 → 名称「Save to Obsidian」。

右下のチェックリストアイコンから設定:
- 「共有シートに表示」 ON
- 受け入れるタイプ: **URL** と **Safari Web ページ** にチェック
  (テキストや画像は OFF にしておくと余計な共有シートに出ない)

## 2. アクションを順に追加

### (1) `URL を取得`
- 入力 = 「ショートカットの入力」

### (2) `テキスト` （任意のメモを聞きたい場合のみ。要らないならスキップ可）
- アクション「入力を要求」を追加し、タイプ「テキスト」「メモ(任意)」「キャンセル時は続行」
- このアクションの出力を「ユーザの入力」変数として保持

### (3) `辞書`
キーと値で以下を組み立てる:

| キー   | 種別     | 値                          |
|--------|----------|-----------------------------|
| url    | テキスト | (1) で得た「URL」           |
| note   | テキスト | (2) のユーザの入力 (任意)   |

`tags` を毎回手で入れたいなら、`配列` 型の値として "ios" など固定タグを入れておくと便利。

### (4) `URL の内容を取得`
- URL                : `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`
- 方法              : `POST`
- 要求の本文          : `JSON`
- 本文              : 上で作った「辞書」
- ヘッダ:
    - `Authorization` = `Bearer <SHARED_SECRET>`
    - `Content-Type`  = `application/json`

### (5) `辞書から値を取得`
- 入力 = (4) の出力
- キー = `path`

### (6) `通知を表示` (任意)
- タイトル: `Saved to Obsidian`
- 本文: (5) で取った `path`

## 3. 共有シートからの利用

X アプリで投稿を開く → 共有アイコン → 「Save to Obsidian」をタップ。
(初回は ショートカット.app の「設定 > 共有シート」で表示順を上げておくと使いやすい)

## 4. Tips

- 失敗時の挙動を強化したいなら、(4) の後に `If` で HTTP ステータスを分岐させ、
  失敗時は `クリップボードにコピー` で URL を退避させると後追いしやすい。
- Apple Watch から URL を投げたいなら、上記ショートカットの「Apple Watch に表示」を ON に。
- Mac の Safari 共有シートにも同じショートカットが出るので、PC 側のサブ動線にもなる。

## 5. 応用: テキスト/Markdown クリップ (ADR 0011)

URL を持たないメモや他アプリのテキスト共有を保存したい場合は、別のショートカット
「Save Text to Obsidian」を同様に作る。受け入れるタイプで **テキスト** を ON にし、
辞書のキーを `url` の代わりに `text`（プレーンテキスト）または `markdown`
（他アプリの Markdown 共有時）にする:

| キー      | 種別     | 値                        |
|-----------|----------|---------------------------|
| text      | テキスト | 共有されたテキスト        |
| note      | テキスト | 追加メモ (任意)           |

`(4) URL の内容を取得` の設定は URL クリップと同じ (`POST` / `JSON` / 同じ Worker URL /
同じ `Authorization` ヘッダ)。`url` キーを入れないことで Worker 側がテキストクリップと
判定し、`source: text-clip` の frontmatter 付きノートとして `Inbox/` に保存する。

## 6. 応用: 画像クリップ (ADR 0011)

写真アプリやスクリーンショットの共有シートから画像を送りたい場合は、辞書ではなく
`URL の内容を取得` の要求の本文を **フォーム** に切り替えて画像添付する:

- 受け入れるタイプ: **画像** を ON にする
- `(4) URL の内容を取得`:
    - URL     : `https://obsidian-clipper.<your-subdomain>.workers.dev/clip`
    - 方法    : `POST`
    - 要求の本文: `フォーム`
    - フィールド:
        - `image` = ファイル = ショートカットの入力 (画像)
        - `title` = テキスト (任意)
        - `note`  = テキスト (任意)
        - `embed` = テキスト = `1` (Attachments に保存した画像を `![[...]]` で
          埋め込んだノートも `Inbox/` に同時生成したい場合のみ。省略時は画像のみ保存)
    - ヘッダ: `Authorization` = `Bearer <SHARED_SECRET>` (`Content-Type` はフォーム
      送信時にショートカットが自動設定するので手動指定しない)

Worker は画像を `Attachments/` に保存し、レスポンスの `path`(画像) と
`embedded`/`notePath`(embed=1 時のみ) を返す。
