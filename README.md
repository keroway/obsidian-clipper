# obsidian-clipper

URL を投げると Cloudflare R2(= Remotely Save の Vault バケット) の `Inbox/`
に Markdown ファイルを作る Cloudflare Worker。
Obsidian は Remotely Save で R2 を pull するので、結果的に Vault に新規ノート
が出現する。

## 動作概要

```
[iPhone X 共有 / Safari 共有 / Chrome bookmarklet]
        │  POST /clip  {url, title?, selection?, note?, tags?}
        ▼
[Cloudflare Worker (Hono)]
   ├ Bearer 認証
   ├ URL 正規化 (UTM, X 共有 ?s, ?t などを除去)
   ├ 本文取得: https://r.jina.ai/<URL>           (無料, 認証なし)
   ├ 要約: Workers AI (任意, ENABLE_SUMMARY)
   └ frontmatter 付き Markdown を R2.put
        │
        ▼
[R2 bucket] ──pull──> [Obsidian (Remotely Save)]
```

## frontmatter スキーマ

Keep 移行スクリプトと同じキー設計にしてあるので Dataview で混ぜて扱える:

```yaml
---
created: 2026-05-16T12:34:56+09:00
updated: 2026-05-16T12:34:56+09:00
source: web-clip
source_url: "https://example.com/article"
source_title: "..."
tags:
  - "clipped"
  - "ios"
summary: "..."
---
```

## セットアップ

### 1. 依存インストール

```bash
cd obsidian-clipper
bun install            # もしくは: npm install
```

### 2. wrangler ログイン

```bash
bunx wrangler login
```

### 3. R2 バケット名を `wrangler.jsonc` に書く

Remotely Save が使っている既存バケット名をそのまま指定。
prefix を使っているなら `VAULT_PREFIX` に `"MyVault/"` のように設定(末尾スラッシュ必須)。
使っていなければ `""` のまま。

確認方法は Obsidian の Remotely Save 設定 → "S3 (-compatible)" → Bucket Name / Folder。

### 4. 共有シークレットを登録

```bash
bunx wrangler secret put SHARED_SECRET
```

長めのランダム文字列を 1 回だけ貼り付ける。あとでブックマークレットと iOS
ショートカットの両方で同じ値を使う。

### 5. デプロイ

```bash
bunx wrangler deploy
```

出力に `https://obsidian-clipper.<your-subdomain>.workers.dev` が出るので控える。

### 6. 動作確認 (curl)

```bash
curl -X POST https://obsidian-clipper.<your-subdomain>.workers.dev/clip \
  -H "Authorization: Bearer <SHARED_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://blog.cloudflare.com/workers-ai-update/","tags":["test"]}'
```

レスポンスに `path` が返り、Obsidian で次回 sync すると `Inbox/` に出現する。

### 7. クライアント設定

- Chrome: `client/bookmarklet.js` を minify してブックマーク URL に登録
- iPhone: `client/ios-shortcut.md` の手順でショートカット作成

## 運用上のメモ

### Remotely Save の同期タイミング

- Mac / Windows: 起動中であれば手動同期 or "Sync on file change" 有効化
- iOS: Obsidian 起動時にのみ走るのが基本
  → クリップ即時反映は諦めて「次に Obsidian を開いたら来ている」体験で良い

### 重複 URL

最初はあえて重複検知を入れていない(タイムスタンプでファイル名が割れるので衝突はしない)。
同じ記事を 2 回保存しがちなら、HANDOFF.md の TODO 参照。

### 料金

- Worker: 無料枠 (1日 10 万リクエスト) に余裕で収まる
- R2: Remotely Save と同じバケット → 追加のストレージ・転送量はほぼ誤差
- Jina Reader: 無料・無認証 (rate limit はあるが個人用途では到達しない)
- Workers AI: Llama 3.1 8B は無料枠 (1日 1 万 neurons) で十分

### セキュリティ

個人利用なので Bearer 1 本でシンプルにしてある。

- 共有先を増やす / 組織で共有する場合は Cloudflare Access (Zero Trust, 個人プラン無料)
  に切り替えて IdP 経由の認証に。
- `SHARED_SECRET` を漏らした場合は `wrangler secret put SHARED_SECRET` で
  上書きすれば即時無効化される (新シークレットを各クライアントに再配布)。

## 次の一手

`HANDOFF.md` を参照。Claude Code に渡すための課題リストと前提情報をまとめてある。
