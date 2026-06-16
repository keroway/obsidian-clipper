# ADR 0006: Webhook による失敗通知の実装

- Status: Accepted
- Date: 2026-06-17

## Context

本文取得失敗・要約失敗が発生しても現状は `console.warn` だけで気づけない。
Cloudflare の観測性ログを常時監視しないユーザーにとって、クリップが無音で劣化保存されていることを知る手段がない。
`NOTIFY_WEBHOOK_URL` を設定したユーザーには非同期 Webhook 通知を送ることで可観測性を向上させる。

## Decision

**`NOTIFY_WEBHOOK_URL` (secret) が設定されているとき、Jina Reader 失敗・要約失敗時に Discord/Slack 互換 JSON を `waitUntil` で非同期 POST する。**

理由:

1. `waitUntil` によりメインレスポンスをブロックしない — 通知の遅延なく 200 が返る。
2. Webhook 失敗でも 200 を維持できる — 既存の「失敗しても 200 を返す」不変条件を守れる。

却下した代替案:

- **Cloudflare Queue / KV へのキューイング**: リトライやデッドレターキューを管理する複雑さが MVP の規模に見合わない。
- **同期的な Webhook 送信**: レスポンス遅延のリスクがあり、Webhook エンドポイントの応答速度に Worker の SLA が依存してしまう。

## Consequences

- 通知の遅延なくメインレスポンスが返る（ポジティブ）。
- Webhook 未設定時は通知なし — オプトイン方式なので既存ユーザーへの影響ゼロ（意図した動作）。
- Webhook 失敗は `console.warn` のみで握り潰す — 不変条件「失敗しても 200 を返す」を守る（ポジティブ）。
- `NOTIFY_WEBHOOK_URL` は secret として管理するため、URL が vars に露出しない（ポジティブ）。
