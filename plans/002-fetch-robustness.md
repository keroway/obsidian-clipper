# 002-fetch-robustness.md

> **Status: DONE** / Priority: High / Dependency: None
> HANDOFF.md TODO #3「本文取得の堅牢化」に対応。
> 実装済み: ADR `docs/adr/0007-fetch-robustness.md`、`src/index.ts` の `fetchArticle`
> (Jina リトライ + Browser Rendering `/markdown` フォールバック)、`src/index.test.ts` の
> `fetchArticle` 単体 5 ケース + `POST /clip - fetch failure invariant` 統合テスト。

## Description

Jina Reader (`https://r.jina.ai/`) が 429 / 5xx を返した場合に本文が空のまま
保存されてしまう。フォールバック経路を追加し、本文取得の成功率を上げる。

## Context

現状 (`src/index.ts` の「1. 本文取得」) は Jina に 1 回 fetch するだけ。

- `res.ok` でなければ `fetchErr = 'jina <status>'` を立てて本文空のまま続行。
- 429 (無料枠 rate limit) は `JINA_API_KEY` 未設定だと初回から当たりやすい
  (CLAUDE.md 明記)。
- 失敗しても 200 を返し URL+メモだけ保存するのが MVP 合意 (= **この挙動は維持**)。

つまり「失敗時 200」の不変条件は崩さず、その前段でリトライ/代替抽出を足すのが本 plan。

## Goals

- Jina が 429/5xx のとき、即あきらめず以下を順に試す:
  1. **指数バックオフ付きリトライ** (429/503 のみ、最大 2 回、Retry-After 尊重)。
  2. リトライしても駄目なら **代替抽出** (下記いずれか、ADR で決定):
     - (案A) Cloudflare Browser Rendering API (`@cf/browser-rendering` / REST)。
     - (案B) 素の `fetch(url)` + 軽量 HTML→Markdown 抽出 (Readability 相当)。
- すべて失敗したら現状どおり `fetchErr` を残して 200 (挙動不変)。
- どの経路で取得できたかを `customMetadata` か `console` に残す (観測のため)。

## Requirements

- **失敗時 200 / URL+メモ保存の不変条件を壊さない** (CLAUDE.md「失敗ポリシー」)。
- frontmatter スキーマ (`source` / `source_url` / `source_title` / `tags` / `summary`)
  は変更しない。
- Wrangler v4 / Hono ^4 / TypeScript strict 維持。
- 追加 env / binding は `wrangler.jsonc` と `Bindings` 型と README に反映。
- リトライ・代替抽出ともタイムアウトを設け、Worker の実行時間を膨らませない
  (要約と合算で CPU/wall 制限に注意)。

## Implementation Steps

1. **ADR**: `docs/adr/` に「Jina フォールバック方式」を記述。案A/案B を比較し、
   Browser Rendering のコスト・有効化要否、または依存ライブラリ追加可否を決める。
2. **リトライ層**: `fetchArticle(url, env)` を切り出し、429/503 のみ指数バックオフ
   (例: 0.5s, 1s) でリトライ。`Retry-After` ヘッダがあれば尊重。AbortController で
   1 リクエストごとタイムアウト。
3. **代替抽出層**: ADR の決定に従い fallback 関数を実装。失敗は throw せず
   `{ md: '', err }` を返す形に統一。
4. **ハンドラ統合**: 現「1. 本文取得」ブロックを `fetchArticle` 呼び出しに置換。
   取得元 (`jina` / `retry` / `fallback`) を変数で持ち、成功時は `customMetadata.via`
   に記録、最終失敗時のみ `fetchErr` を残す。
5. **通知**: 既存 `NOTIFY_WEBHOOK_URL` 経路を再利用し、最終失敗時のみ通知 (リトライ
   途中で通知しない)。

## Verification

- **Unit**: `fetchArticle` を Jina 200 / 429→200 (リトライ成功) / 429×N→fallback 成功 /
  全失敗 の 4 ケースで `fetch` をモックして検証 (`src/index.test.ts` に追加)。
- **Integration**: Jina を 429 固定にしたモックで `POST /clip` が 200 を返し、
  本文ありで R2 PUT されること (fallback 成功時) / 本文空+fetchErr (全失敗時) を確認。
- **不変条件回帰**: 全経路失敗でも `200 OK` かつ URL/メモが保存されることを明示テスト。

## Maintenance Notes

- Browser Rendering を採用する場合、無料枠/課金とレイテンシ増を README に明記。
- リトライ回数/バックオフは env 化しすぎず定数で十分 (個人ツール)。

## Drift Detection

- Commit: `0fb41e6`
- Plan was written against this commit. 実装前に `src/index.ts` の「1. 本文取得」
  ブロックが変わっていないか差分確認すること。
</content>
