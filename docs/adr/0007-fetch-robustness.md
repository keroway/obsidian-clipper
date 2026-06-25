# ADR 0007: 本文取得の堅牢化 (Jina フォールバック)

- Status: Accepted
- Date: 2026-06-21
- Issue: #34 (受け入れ条件は本 0007 で満たす。issue 本文の `0004-jina-fallback.md`
  は起案時の仮番号で、実装時の ADR 番号進行に合わせ 0007 に確定した)

## Context

本文取得は Jina Reader (`https://r.jina.ai/<URL>`) への 1 回の `fetch` だけで、
`res.ok` でなければ `fetchErr` を立てて本文空のまま続行している (`src/index.ts` の
「1. 本文取得」)。

- 無料枠は `JINA_API_KEY` 未設定だと 429 (rate limit) に当たりやすい (CLAUDE.md 明記)。
- 一時的な 5xx でも即あきらめるため、本文が空のノートが保存されてしまう。
- ただし「取得失敗でも 200 を返し URL+メモは保存する」のは MVP の合意であり、
  **この失敗ポリシーは維持する** (CLAUDE.md「失敗ポリシー」)。

成功率を上げつつ失敗時の挙動を変えない、前段の補強が必要。

## Decision

**Jina が 429/503 のときのみ指数バックオフで最大 2 回リトライし、なお失敗したら
Cloudflare Browser Rendering の `POST /markdown` エンドポイントにフォールバックする。
すべて失敗した場合は現状どおり `fetchErr` を残して 200 を返す。**

取得ロジックは `fetchArticle(url, env)` に切り出し、`{ md, title?, via, err? }` を返す。
`via` は `'jina' | 'jina-retry' | 'browser-rendering'` のいずれかで、成功経路を
`customMetadata.via` に記録する。

理由:

1. **代替経路が Jina と同形**: Browser Rendering の `POST /markdown`
   (`https://api.cloudflare.com/client/v4/accounts/<id>/browser-rendering/markdown`)
   は URL を渡すと本文 Markdown を返す。出力が Jina とほぼ同形のため `renderNote()` の
   本文セクションにそのまま流せ、frontmatter スキーマも変更不要。
2. **SPA/JS 後挿入に強い**: Browser Rendering はヘッドレス Chrome でレンダリング後に
   抽出するため、Jina が苦手な JS 後挿入の本文 (HANDOFF「既知の制約」) もカバーできる。
3. **依存追加が不要**: REST API を `fetch` で叩くだけ。Readability WASM 等の
   npm 依存を増やさず TypeScript strict / Wrangler v4 を維持できる。
4. **任意機能として安全に追加できる**: `CF_ACCOUNT_ID` + `BROWSER_RENDERING_API_TOKEN`
   が未設定なら fallback をスキップし、従来挙動 (Jina のみ) に degrade する。

却下した代替案:

- **Readability WASM を Worker 内実行**: 依存とバンドルサイズが増え、SPA の JS 後挿入
   本文は取れない。Browser Rendering の方が抽出品質・保守性で優位。
- **Browser Rendering binding (Puppeteer/Playwright) を使う**: 本文取得 1 回には
   過剰。REST `POST /markdown` 一発で足りるため binding は導入しない。
- **無制限リトライ / 全ステータスでリトライ**: Worker の wall-time を圧迫し、要約と
   合算で実行時間制限に当たりうる。429/503 のみ・最大 2 回・各リクエストに
   `AbortController` タイムアウトを課す。

## Consequences

- 取得成功率が上がり、本文空ノートが減る。一方で失敗時は最大
  「Jina ×3 (初回+リトライ2) + Browser Rendering ×1」の往復が発生し、最悪ケースの
  レイテンシは増える。タイムアウトを各段に課して上限を抑える。
- 新 env を追加: `CF_ACCOUNT_ID` / `BROWSER_RENDERING_API_TOKEN` (secret)。
  未設定でも動く (fallback 無効化)。`wrangler.jsonc` / `Bindings` 型 / README に反映。
- Browser Rendering 利用分の課金が発生しうる (フォールバック時のみ)。無料枠と
   レイテンシ増を README に明記する。
- 失敗通知 (`NOTIFY_WEBHOOK_URL`) は **最終失敗時のみ** 送る。リトライ途中・
   フォールバック成功では通知しない (ノイズ抑制)。
- `via` を `customMetadata` に残すことで、どの経路で取れたかを後から確認できる
   (簡易的な観測性。本格的な観測性は別 plan)。
</content>
