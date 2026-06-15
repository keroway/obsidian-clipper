# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

このリポジトリは Cloudflare Worker (Hono + TypeScript) の小さな Read It Later パイプライン。
利用者向け手順は `README.md`、未実装 TODO とロードマップは `HANDOFF.md` にある。
本ファイルは「読まないと分からない設計前提」と最低限の開発コマンドだけを置く。

## Commands

依存導入とローカル開発は bun 推奨 (README に明記)、`npm` でも可。

- `bun install` — 依存導入
- `bun run dev` — `wrangler dev`。動作確認の最短ループは `wrangler dev` + curl POST。
- `bun run typecheck` — `tsc --noEmit`。TypeScript strict を維持すること。
- `bun run deploy` — `wrangler deploy`
- `bun run tail` — `wrangler tail` で本番ログ
- `bunx wrangler secret put SHARED_SECRET` — Bearer 認証用シークレット投入
- `bunx wrangler secret put JINA_API_KEY` — Jina Reader の API キー (任意。未設定でも動くが rate limit が緩くなる)
  (HANDOFF にある要約モデル切替 TODO を実装するなら `ANTHROPIC_API_KEY` も同様に投入)

テストは vitest + `@cloudflare/vitest-pool-workers` で導入済み（`src/index.test.ts`）。追加テストを書く場合は同ファイルを参照。

## Architecture

リクエスト 1 本 = R2 ファイル 1 本のパイプライン。実装は `src/index.ts` 単一ファイル。

1. `POST /clip` を Hono で受ける。`bearerAuth` で `SHARED_SECRET` を検証、CORS は `*` (ブックマークレット / iOS ショートカットから叩く前提)。
2. `normalizeUrl()` で UTM / `gclid` / X の `?s` `?t` 等を除去し、`mobile.twitter.com` と `twitter.com` を `x.com` に揃える。許可リストは `TRACKING_PARAMS`。
3. `https://r.jina.ai/<URL>` で本文 Markdown を取得。`JINA_API_KEY` (secret) が設定されていれば `Authorization: Bearer` を付与して無料枠の rate limit を緩和する。未設定でも従来通り無認証で動作するが、初回から 429 に当たりやすいので推奨。
4. `ENABLE_SUMMARY === 'true'` かつ本文 200 文字超なら `summarize()` で Workers AI (`SUMMARY_MODEL`, 既定 `@cf/meta/llama-3.1-8b-instruct`) に投げる。
5. JST タイムスタンプ + サニタイズ済みタイトルで `YYYY-MM-DD_HHMMSS_<slug>.md` を組み立て、`${VAULT_PREFIX}${INBOX_FOLDER}/${filename}` を key として `c.env.VAULT.put`。
6. Obsidian 側は Remotely Save が R2 を pull することでノートを取り込む (Worker は Obsidian に直接触らない)。

**失敗ポリシー**: 本文取得失敗 / 要約失敗のどちらも握り潰して 200 を返す。Jina 失敗時は `fetchErr` を本文セクションに残し、要約失敗は `console.warn` のみ。URL とユーザメモだけでも保存されるのが MVP の合意なので、ここで HTTPException を投げないこと。

**バインディング** (`wrangler.jsonc`):

- `VAULT` — R2Bucket。Remotely Save が使っている既存バケットをそのまま指定する前提。
- `AI` — Workers AI
- vars — `VAULT_PREFIX` (Remotely Save 側で prefix を使っているなら `MyVault/` のように末尾スラッシュ付き、無いなら `""`)、`INBOX_FOLDER` (既定 `Inbox`)、`ENABLE_SUMMARY`、`SUMMARY_MODEL`
- secret — `SHARED_SECRET`

## 設計上の不変条件

壊すと Obsidian 側 / Dataview / ファイル名が破綻するので注意:

- **frontmatter スキーマは Keep 移行スクリプトと共通**: `created` / `updated` / `source` / `source_url` / `source_title` / `tags` / `summary`。`source: web-clip` を変えると Dataview クエリが壊れる。`renderNote()` を編集する際はキー名を変えないこと。
- **Remotely Save は暗号化 OFF 前提**。暗号化を ON にすると Worker 直書きが Obsidian 側で読めない。README にも明記。
- **`VAULT_PREFIX` は末尾スラッシュ必須または空文字**。`key` 組み立てが `${prefix}${folder}/${filename}` なので、`MyVault` だけだと `MyVaultInbox/...` になる。
- **`INVALID_FILENAME_RE` (`/[\\\/:*?"<>|\[\]#^`]/`)** は macOS / Windows / Obsidian 全部で安全な共通部分集合。緩めない。
- **時刻は JST 固定**。`jstStamp` / `jstIso` で `+9h` をオフセットしている。Worker は UTC で動くので `Date` を直接フォーマットしないこと。
- TypeScript strict / Wrangler v4 / Hono ^4 を維持 (HANDOFF 記載の前提)。
- **Wrangler v4 から `wrangler kv` / `wrangler r2` 系はデフォルト local モード**。本番 R2/KV を直接操作するときは `--remote` を明示する (例: `bunx wrangler r2 object get VAULT/Inbox/foo.md --remote`)。`dev` / `deploy` / `tail` / `secret` は従来通り。

## ファイル地図

- `src/index.ts` — Worker 全部 (ルータ + ユーティリティ)。新規ユーティリティもまずここに足し、肥大化したら分割を検討。
- `wrangler.jsonc` — バインディング / vars。`bucket_name` は `REPLACE_WITH_YOUR_R2_BUCKET_NAME` のプレースホルダのままなので、デプロイ前に書き換えが必須。
- `client/bookmarklet.js` — Chrome 用ブックマークレットの未 minify 版 (`WORKER_URL` / `SECRET` を書き換えて minify → ブックマーク URL に貼る)。
- `client/ios-shortcut.md` — iOS ショートカット組み立て手順 (ショートカットファイル自体は配布不可)。
- `README.md` — エンドユーザ向けセットアップ手順。
- `HANDOFF.md` — 未実装 TODO (URL 重複検知 / 要約モデル切替 / Jina フォールバック / タグ自動付与 / 失敗通知 / テスト / 観測性) と進め方の指針。新規作業前に必読。

## 作業の進め方

- 機能追加は HANDOFF.md の方針通り、まず `docs/adr/` に ADR を書いてから着手（`docs/adr/0000-template.md` をコピーして使う）。
- 動作確認の最短ループ:
  ```
  bun run dev
  curl -X POST http://127.0.0.1:8787/clip \
    -H "Authorization: Bearer <SHARED_SECRET>" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/article","tags":["test"]}'
  ```
- iOS では Obsidian 起動時にしか Remotely Save が pull しない。「クリップ即時反映」は仕様外なので、即時性を担保する設計に倒さないこと。
