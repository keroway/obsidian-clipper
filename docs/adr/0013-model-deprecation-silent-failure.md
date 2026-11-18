# ADR 0013: 要約モデル廃止による無音の要約欠落と再発防止

- Status: Accepted
- Date: 2026-11-18

## Context

`SUMMARY_MODEL` の既定 `@cf/meta/llama-3.1-8b-instruct` が Workers AI で 2026-05-30 に
廃止され、以降の要約呼び出しはすべて `5028: ... was deprecated` で失敗していた。
失敗ポリシー（本文取得・要約の失敗は握り潰して 200 を返す、CLAUDE.md 参照）により
ノート保存自体は成功し、クライアント (iOS ショートカット) からは成功に見えた。
`NOTIFY_WEBHOOK_URL` も未設定で、少なくとも 9/5〜11/17 の保存ノートすべてで
`summary` が欠落したまま気づけなかった (`wrangler tail` で原因を確認)。

## Decision

**既定モデルを同系統の `@cf/meta/llama-3.1-8b-instruct-fp8` に置き換え、失敗通知の
Webhook を運用上必須の設定として扱う。失敗ポリシー (握り潰して 200) は変えない。**

理由:

1. 同系統の fp8 版は日本語要約が動くことを `wrangler dev --remote` で実機確認済み。
   品質評価 (HANDOFF.md の #16/#17) の前提も大きく変わらない。
2. 失敗ポリシー自体は正しい (URL とメモだけでも保存する MVP の合意)。問題は
   「失敗が見える経路が無かった」ことなので、通知経路の設定漏れを塞ぐ。
3. `notifyWebhook` は Slack (`text`) と Discord (`content`) の両形式を送るため、
   コード変更なしに `wrangler secret put NOTIFY_WEBHOOK_URL` だけで有効化できる。

却下した代替案:

- 要約失敗時に 5xx を返す: 失敗ポリシーと矛盾し、保存まで失われる。
- モデルを Anthropic (`SUMMARY_PROVIDER=anthropic`) へ切り替える: 別件の判断で
  あり、本件の復旧には不要。

## Consequences

- モデルの廃止は将来も起きうる。`SUMMARY_MODEL` を使う設定・README・テストが
  複数箇所にあるため、変更時は `grep` で全箇所を揃える (HANDOFF.md は歴史的記録なので除く)。
- Webhook 未設定だと、本文取得・要約・タグ生成の失敗がすべて無音になる。
  デプロイ後の確認項目に `NOTIFY_WEBHOOK_URL` の有無を含める。
- 通知は失敗が起きたクリップ時にしか出ない。**クリップが無い期間の廃止は検知できない**。
  定期ヘルスチェック (Cron Trigger で要約を 1 本試し、失敗なら通知) は未実装の
  フォローアップ候補で、必要になった時点で別 ADR で決める。
- 本番デプロイは `wrangler.jsonc` の `bucket_name` がプレースホルダのため、
  バケット名を差し替えた一時 config (`--config`) で行った。リポジトリは書き換えない。
