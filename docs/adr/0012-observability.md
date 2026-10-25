# ADR 0012: 観測性 (クリップ成否と失敗種別の把握)

- Status: Accepted
- Date: 2026-10-25

## Context

HANDOFF TODO #7 (観測性) のみ未着手で、#227 で起案された。現状:

- `wrangler.jsonc` は既に `observability.enabled = true` で、**Workers Logs は有効**。
  ただしログは自由文の `console.warn` / `console.log` が散在しており、
  「クリップが成功したか」「どの失敗種別が何件か」をフィルタ・集計できる形ではない。
- 失敗は webhook (ADR 0006) で即時通知されるが、通知は異常時の push のみ。
  成功率や処理時間といった継続的な傾向は見えない。
- 個人用ツールで、実運用上の必要性は未確認 (plans/README.md)。過剰な基盤は持ち込まない。

調査結果 (Cloudflare docs, 2026-10-25 時点):

- Workers Logs: Free は保持 3 日 / 200,000 イベント/日、Paid は保持 7 日。
  `console.log({...})` のようにオブジェクトで出すと各フィールドが索引化され、
  ダッシュボードの Observability タブでキー指定の絞り込みができる。
  `head_sampling_rate` で間引き可 (既定 1 = 全件)。2026-12-01 から
  Cloudflare Observability 課金体系へ移行予定。
- Analytics Engine: `analytics_engine_datasets` バインディングと `writeDataPoint()`
  (blobs / doubles / index 1 つ) で集計用データを書け、SQL API で長期集計できる。
  ただし API トークン・クエリ運用が別途必要。
- Logpush: 外部ストレージへの転送用で、個人ツールには運用負荷が見合わない。

## Decision

**既存の Workers Logs を使い、クリップ 1 件につき 1 行の構造化イベントを `console.log(オブジェクト)` で出す。Analytics Engine / Logpush は導入しない。**

イベント形 (案):

```
{ event: 'clip', kind: 'url'|'text'|'image', outcome: 'saved'|'duplicate'|'error',
  status, durationMs, host?, fetchVia?: 'jina'|'browser'|'none',
  fetchFailed?: boolean, summaryFailed?: boolean, tagsFailed?: boolean }
```

理由:

1. 追加の課金・バインディング・トークンが不要で、設定済みの基盤だけで完結する。
2. 失敗種別 (本文取得 / 要約 / タグ) は既に分岐が存在し、フラグを載せるだけで済む。
3. 必要性が未確認の段階では最小構成が妥当。足りなければ後から Analytics Engine を足せる
   (イベント形をそのまま `writeDataPoint` に写せる)。

記録しないもの (機密・個人情報): 完全な URL・パス・クエリ、タイトル、note / selection /
本文、タグ、Authorization、secret。`host` のみ許容 (`warningTarget` と同方針, #262)。

却下案:

- Analytics Engine: 長期集計が可能だが、現時点で長期傾向の必要性が未確認。
- Logpush: 転送先の運用が過剰。
- `invocation_logs` / サンプリング設定の変更: 件数が少なく現状で無料枠内。変更しない。

## Consequences

- Free プランでは保持 3 日のため、傾向は直近数日のみ。長期の成功率は見えない。
  長期が必要になったら Analytics Engine を追加する (別 ADR)。
- 2026-12-01 の課金体系移行で無料枠の扱いが変わりうる。移行後に月間ログ量を確認する。
- 構造化イベントは `src/index.ts` の各ハンドラ終端に 1 箇所ずつ入る
  (`src/observe.ts` に `logClipEvent()` を切り出し、テストで機密フィールドを含まないことを検証する)。
- 運用確認手順 (ダッシュボードの Observability タブで `event = clip` を `outcome` 別に絞る、
  `bun run tail` での確認) を README に追記する。
