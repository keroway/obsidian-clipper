
# ADR 0009: プロンプト共有モジュール化とコアの責務分割

- Status: Accepted
- Date: 2026-07-11

## Context

`src/index.ts` が 830 行超に肥大化し、CLAUDE.md の「肥大化したら分割を検討」の
ラインに達した。加えて `scripts/compare-summary-models.ts` が
`SUMMARY_SYSTEM_PROMPT` / `SUMMARY_EXCERPT_LIMIT` / `buildSummaryUserPrompt` /
`max_tokens` を `src/index.ts` から手動コピーしており、本番側を変更したら
比較ハーネス側も必ず同期する運用上の負債になっていた (HANDOFF.md に注意書き)。

CLAUDE.md には「実装は `src/index.ts` 単一ファイル」という記述があるが、
本 ADR の決定により以下のとおり更新する。

## Decision

**プロンプト定数を `src/prompts.ts` に切り出して共有し、`src/index.ts` の
責務を fetch / LLM / タグ / ノート整形 / URL インデックス / 通知 / 時刻 の
各モジュールに分割する。公開 API (`export` されテストされる関数のシグネチャ)
は変更しない。**

分割方針:

| ファイル | 責務 |
|---|---|
| `src/prompts.ts` | 要約・自動タグ生成のプロンプト定数と `buildSummaryUserPrompt` |
| `src/fetch-article.ts` | Jina Reader 取得・リトライ・Browser Rendering フォールバック |
| `src/llm.ts` | 要約・タグ生成 (Workers AI / Anthropic 呼び出し) |
| `src/tags.ts` | タグ正規化・統合・ホスト名 allowlist |
| `src/note.ts` | `renderNote` とファイル名サニタイズ |
| `src/url-index.ts` | URL 重複検知インデックスの読み書き |
| `src/notify.ts` | Webhook 通知 |
| `src/time.ts` | JST タイムスタンプ生成 |
| `src/bindings.ts` | `Bindings` 型 (循環 import 回避のため単独ファイル) |
| `src/index.ts` | Hono ルータ (`normalizeUrl` / `hostname` を含む) のみ |

却下した代替案:

- **単一ファイル維持**: プロンプト共有だけを `src/prompts.ts` に切り出し、
  それ以外は分割しない案。同期負債は解消できるが、830 行の肥大化そのものは
  残る。今回は分割まで実施することで両方を解消する。

## Consequences

- `scripts/compare-summary-models.ts` は `src/prompts.ts` から import し、
  手動コピーと「必ず同期」の注意書きが不要になる。
- `src/index.test.ts` の import 元を新モジュールへ張り替える。テスト内容・
  期待値 (frontmatter スキーマ含む) は不変。
- CLAUDE.md の「実装は `src/index.ts` 単一ファイル」という記述、および
  ファイル地図を分割後の構成に更新する。
- 振る舞いは変更しない (リファクタリングのみ)。`bun run typecheck` /
  `bun run test` / `bun run lint` の green を受け入れ条件とする。
