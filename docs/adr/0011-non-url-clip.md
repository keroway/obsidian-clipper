# ADR 0011: URL 以外の入力 (Markdown / テキスト / 画像) の受け入れ

- Status: Accepted
- Date: 2026-07-24

## Context

現行の `POST /clip` は `url` を必須とし、Jina Reader で本文を取得して
frontmatter 付き Markdown を R2 に保存する「URL 起点」一本道のパイプライン
だった。しかし Obsidian に登録したいものは URL 記事だけではなく、既に手元に
ある Markdown / プレーンテキスト（メモ、引用、他アプリからの共有テキスト）、
スクリーンショットなどの画像も含まれる。これらを同じクリッパー経路 (ブック
マークレット / iOS ショートカット) から Vault に取り込みたい。

## Decision

**単一 `POST /clip` を維持し、`Content-Type` とボディ内容で入力種別を分岐
する。エンドポイントは分割しない。**

判別 (優先順):

1. `Content-Type: multipart/form-data` → 画像クリップ
2. JSON で `url` あり → 既存 URL クリップ (挙動不変)
3. JSON で `url` なし & `markdown` または `text` あり → テキストノートクリップ
4. いずれも該当せず → 400

理由:

1. `client/bookmarklet.js` / `client/ios-shortcut.md` が `/clip` をハード
   コードしており、認証 (`bearerAuth`) と CORS ミドルウェアも
   `app.use('/clip', ...)` でパス単位に付いている。単一パス維持がクライアン
   ト再セットアップ不要で最小変更。
2. 判別ロジックは 3 パターンで明快。`src/clip-input.ts` に純関数として切り
   出し、workerd 起動なしの unit test を可能にする。

却下した代替案:

- **`/clip/text`, `/clip/image` へのエンドポイント分割**: クライアント側の
  変更コストが増え、認証/CORS ミドルウェアの重複設定も必要になるため不採用。

### frontmatter `source` の命名

既存 `renderNote` の `source: web-clip` ハードコードを `source?: string`
(既定 `'web-clip'`) に変更し、呼び出し側で上書き可能にする。新しい値:

- テキスト / Markdown クリップ: `text-clip`
- 画像 embed ノート (後述): `image-clip`

`renderNote` の `url` / `body` / `summary` も optional 化し、URL を持たない
入力 (テキスト・画像) でも `source_url` 行や `<url>` 描画をスキップする。
**frontmatter のキー名・順序、および既存 URL クリップの `source: web-clip`
は不変** (Dataview 互換性のため)。

### テキスト / Markdown クリップ

`markdown` または `text` フィールドの内容をそのまま `## 本文` に流し込み、
既存 `renderNote` で frontmatter を付けて `.md` として `INBOX_FOLDER` に
保存する。要約・自動タグ・ホストタグ・URL 重複検知は対象外 (URL/記事取得
という前提が無いため)。

既知の制約: 入力 Markdown が自前の frontmatter を含む場合、`## 本文` 配下
にそのまま埋め込まれ二重 frontmatter になり得る。v1 では検出・除去は行わ
ない。

### 画像クリップ

`multipart/form-data` の `image` フィールド (File) を受け取り、許可 MIME
(`image/png`, `image/jpeg`, `image/gif`, `image/webp`。SVG は XSS 懸念があ
るため v1 では対象外) を検証した上で、新設フォルダ `ATTACHMENTS_FOLDER`
(既定 `Attachments`, `VAULT_PREFIX` 直下) にバイナリのまま保存する。

- サイズ上限: `MAX_IMAGE_BYTES` (既定 10MiB)。超過は `413`。非対応 MIME は
  `415`。
- 重複検知: 画像バイトの SHA-1 (`sha1HexBytes`) を計算し、既存の
  `Inbox/.index/urls.json` に URL ハッシュと同じ名前空間で相乗りさせる
  (SHA-1 40 桁のキー空間なので衝突は無視できる)。2 回目以降は
  `{ ok:false, duplicate:true, path }` を返し、`?refresh=1` で無視できる
  (既存 URL クリップと同じ CAS ロジック `writeUrlIndexCAS` を再利用)。
- `embed=1` (または `title`/`note`/`tags` のいずれかが同梱) が指定された
  場合のみ、`INBOX_FOLDER` に `![[Attachments/<filename>]]` を本文に埋め込
  んだ companion ノート (`source: image-clip`) を追加生成する。既定では画
  像バイナリの保存のみを行い、ノートは生成しない。

却下した代替案:

- **画像専用の別 index ファイル**: `writeUrlIndexCAS` の CAS ロジックを二重
  管理することになるため不採用。既存 index への相乗りで十分。
- **embed ノートを常時生成**: 「画像だけ置きたい」ユースケースを阻害する
  ため、フラグ制のオプトインとした。

## Consequences

- `src/note.ts`: `renderNote` のシグネチャ変更 (後方互換、`source`/`url`/
  `body`/`summary` を optional 化)。
- `src/url-index.ts`: `sha1HexBytes` を追加 (既存 `sha1Hex` は内部委譲に
  リファクタ、公開シグネチャ不変)。
- `src/clip-input.ts` (新設): Content-Type / JSON ボディの入力種別判別。
- `src/attachment.ts` (新設): 画像の MIME/サイズ検証・R2 キー組み立て・
  書き込み。
- `src/bindings.ts` / `wrangler.jsonc`: `ATTACHMENTS_FOLDER` /
  `MAX_IMAGE_BYTES` の vars を追加。
- `src/index.ts`: `POST /clip` をディスパッチャ化し、既存 URL フローは
  `handleUrlClip` として挙動を変えずに関数分離。`handleTextClip` /
  `handleImageClip` を追加。
- README / クライアント (`client/bookmarklet.js`,
  `client/ios-shortcut.md`) にテキスト・画像送信手順を追記する。
- 既存の URL クリップ (`{ url: ... }` JSON POST) の挙動・レスポンス形式・
  frontmatter は完全に不変。
