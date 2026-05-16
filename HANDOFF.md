# HANDOFF — Claude Code への引き継ぎ

`obsidian-clipper` MVP を Claude Code に渡して次のフェーズを進める用のプロンプト。
そのままコピペすれば文脈ごと渡せるようになっている。

---

## 引き継ぎ用プロンプト (Claude Code に貼る)

> 以下のリポジトリ `obsidian-clipper` は、Cloudflare Worker (Hono + TypeScript) で
> URL を受け取り、Jina Reader (https://r.jina.ai/) で本文 Markdown 化、
> Workers AI で要約、Remotely Save が使う R2 バケットの `Inbox/` フォルダに
> frontmatter 付き Markdown を PUT する Read It Later パイプラインです。
>
> Vault は Obsidian + Remotely Save (R2, 暗号化なし) で同期しています。
>
> **現状** (= MVP, 1 リクエスト = 1 ファイル新規作成、重複検知なし、観測性最小)
> を踏まえ、以下のいずれか/複数を実装してください。要件・実装方針・テストを
> ADR (engineering:architecture スキル) として `docs/adr/` に残してから着手。
>
> ### TODO 候補
>
> 1. **URL 重複検知**
>    - `Inbox/.index/urls.json` (R2 上) に `{ sha1(url): { path, createdAt } }` を持ち、
>      既存 URL の場合は新規作成せず "duplicate" のレスポンスを返す。
>    - 上書き再取得モード `?refresh=1` を用意。
>
> 2. **要約モデルの切り替え**
>    - Workers AI の Llama 3.1 8B では日本語要約品質に不満が出るケースを想定。
>    - `SUMMARY_PROVIDER` env で `workers-ai` / `anthropic` を切り替え。
>    - Anthropic API キーは `wrangler secret put ANTHROPIC_API_KEY` で投入。
>    - フォールバック: Anthropic 障害時は workers-ai に自動切替。
>
> 3. **本文取得の堅牢化**
>    - Jina Reader が 429/5xx を返した場合、Mozilla Readability の WASM 版で
>      Worker 内抽出にフォールバック (もしくは Browser Rendering API)。
>    - 最終的にも失敗したら URL とユーザメモだけ保存して 200 を返す
>      (現状の挙動を維持しつつログに残す)。
>
> 4. **タグ自動付与**
>    - 本文 + URL ホスト名から LLM で 3 個までタグ生成。
>    - allowlist (`zenn.dev` -> `tag: zenn` など) も併用。
>
> 5. **失敗通知**
>    - Slack / Discord Webhook に失敗イベントを送る。
>    - `Tail Worker` でなく、`fetch` で個別通知 (理由: 個人 Slack の DM 宛で十分)。
>
> 6. **テスト**
>    - vitest + `@cloudflare/vitest-pool-workers` でユニット (normalizeUrl,
>      renderNote, sanitizeForFilename) と統合 (POST /clip → R2 PUT モック)。
>    - Jina Reader / Workers AI は `MSW` 相当でモック。
>
> 7. **観測性**
>    - Workers Logpush → R2 もしくは Logflare へ。
>    - メトリクス: クリップ回数 / 要約成功率 / 平均レイテンシ。
>
> ### 進め方の指針
>
> - 着手前に上記から優先度上位 1-2 件を選び、ADR を書いてから実装。
> - 既存 frontmatter スキーマ (`source`, `source_url`, `source_title`, `tags`, `summary`)
>   は Keep 移行スクリプトと共通なので互換を壊さないこと。
> - Wrangler v4, hono ^4, TypeScript strict 維持。
> - 動作確認は wrangler dev + curl の最小ループで OK。

---

## 関連リンクと根拠

- Cloudflare Workers (Hono): https://hono.dev/docs/getting-started/cloudflare-workers
- Cloudflare R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Workers AI models 一覧: https://developers.cloudflare.com/workers-ai/models/
- Workers AI 価格 / 無料枠: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Jina Reader 仕様: https://jina.ai/reader/
- Remotely Save README: https://github.com/remotely-save/remotely-save
- Cloudflare Access (Zero Trust, 個人プラン無料): https://developers.cloudflare.com/cloudflare-one/applications/
- vitest-pool-workers: https://developers.cloudflare.com/workers/testing/vitest-integration/
- HTTP semantics (RFC 9110): https://datatracker.ietf.org/doc/html/rfc9110
- Problem Details (RFC 9457): https://datatracker.ietf.org/doc/html/rfc9457

## 既知の制約 / 設計の前提

- Remotely Save は **暗号化なし**前提。OFF を切らないと Worker 直書きは効かない。
- iOS では Obsidian 起動時にしか pull されない。即時性は捨てている。
- 個人利用 1 名前提の Bearer 1 本認証。複数人化したら Cloudflare Access へ。
- Jina Reader の本文抽出はメディア記事には強いが、SPA で JS 後挿入の本文や
  paywall は取れない。代替経路として Cloudflare Browser Rendering を検討余地あり。
