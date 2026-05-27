<!--
PR テンプレート。不要なセクションは消して構いません。
このリポジトリは solo + PR ベース運用 (main は squash merge のみ、typecheck / gitleaks が必須チェック)。
-->

## 概要

<!-- 何を・なぜ変えたか。1〜3行で。 -->

## 関連 Issue

<!-- 例: Closes #12 / Refs #20。なければ「なし」。 -->

## 変更内容

-

## 動作確認

- [ ] `bun run typecheck` が通る
- [ ] (挙動が変わる変更) `bun run dev` + curl POST で `/clip` を確認した
  ```sh
  curl -X POST http://127.0.0.1:8787/clip \
    -H "Authorization: Bearer <SHARED_SECRET>" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/article","tags":["test"]}'
  ```

## 設計上の不変条件チェック (CLAUDE.md 参照)

該当する変更がある場合のみ確認:

- [ ] frontmatter スキーマ (`created`/`updated`/`source`/`source_url`/`source_title`/`tags`/`summary`、`source: web-clip`) を変えていない
- [ ] 時刻は JST 固定 (`jstStamp`/`jstIso`) のまま、`Date` を直接フォーマットしていない
- [ ] `VAULT_PREFIX` は末尾スラッシュ必須 or 空文字の前提を崩していない
- [ ] `INVALID_FILENAME_RE` を緩めていない
- [ ] 本文取得 / 要約失敗時に 200 を返す「失敗握り潰し」ポリシーを維持している
- [ ] TypeScript strict / Wrangler v4 / Hono ^4 を維持

## その他 / 補足

<!-- レビュー時に見てほしい点、未対応事項、HANDOFF.md への追記など。 -->
