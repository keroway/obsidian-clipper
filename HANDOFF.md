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

## 要約モデル比較ハーネス (Issue #16)

`@cf/meta/llama-3.1-8b-instruct` の日本語要約に他言語混入が出るため、Workers AI 内で
別モデルを比較するための再現可能スクリプトを `scripts/compare-summary-models.ts` に置いた。
本番 Worker と**同一のシステムプロンプト / 抜粋上限 / max_tokens** で各モデルに同じ記事を
要約させ、要約文・レイテンシ・他言語混入の有無を Markdown で出力する。

- wrangler ではなく CF REST API (`/accounts/{id}/ai/run/{model}`) を直叩きするので、
  `wrangler.jsonc` の R2 バインディング等を設定しなくても単体で動く。
- 比較対象記事は `scripts/sample-articles.txt` (1 行 1 URL) で管理。**5 本以上**にすること。
- 出力をそのまま Issue #5 にコメントするのが受け入れ条件。

```bash
export CF_ACCOUNT_ID=<account id>
export CF_API_TOKEN=<Workers AI 実行権限のある API トークン>
export JINA_API_KEY=<任意>
bun run compare:summary                       # sample-articles.txt の URL を使用
bun run compare:summary --models @cf/a,@cf/b  # 候補モデルを上書き
```

> **注意**: `scripts/compare-summary-models.ts` 内の `SUMMARY_SYSTEM_PROMPT` /
> `SUMMARY_EXCERPT_LIMIT` / `buildSummaryUserPrompt` / `max_tokens` は `src/index.ts` の
> コピー。本番側を変えたらスクリプト側も必ず同期すること (比較の忠実性のため)。

### 比較結果と決定 (#16 / #17)

公開記事 5 本 (Cloudflare blog 3 + zenn 2) で比較した結果、**採用モデルは現行の
`@cf/meta/llama-3.1-8b-instruct` を継続**する (既定値の変更なし)。根拠:

- **コスト/速度**: 平均 1265ms と最速・最安。70B (llama-3.3) は約 7000ms、mistral-small-24b は約 5000ms と 4〜7 倍遅い。
- **品質差は限定的**: 8B でも他言語混入 0/5、3〜5 文の散文を満たす。期待したほどの差は出なかった。
- **ハルシネーション耐性**: 取得が 404 になった記事で、8B は正直に「404」と要約した一方、大型モデルは存在しない内容を捏造した。

> 注: 当初候補の `@cf/qwen/qwen2.5-7b-instruct` / `@cf/google/gemma-2-9b-it` は ID 誤りで
> 全滞 (`No route for that URI`) し未検証。再評価する場合は公式一覧で現行 ID を確認して
> `--models` で渡すこと。より高品質が要るときは `SUMMARY_PROVIDER=anthropic` (Claude Haiku 4.5, 実装済み #6) も選択肢。

### Claude Agent SDK は不採用 (検討のみ)

「Anthropic API 従量課金の代わりに Claude Agent SDK を使えばサブスク相当クレジットで
要約を回せるのでは」という案を検討したが、**要約用途では不採用**。`SUMMARY_PROVIDER=anthropic`
の現行実装 (`POST /v1/messages` 直叩き, #6) を維持する。根拠:

- **ランタイム非互換 (致命的)**: Agent SDK は Claude Code ランタイム (ネイティブバイナリ /
  `@anthropic-ai/claude-code` CLI) のラッパーで `claude` プロセスを spawn する前提。
  要約は Worker のエッジランタイム内で同期実行しており、サブプロセス起動も Node の
  `child_process` も fs も無いため Worker 内では動かせない。設定では回避不能。
- **ToS**: 公式ドキュメントが "Anthropic generally does not permit third-party developers to
  offer `claude.ai` login or rate limits for their products, so API key authentication is the
  recommended method" と明記。個人サブスク枠を自動バックエンドの動力源にするのはグレー。
- **オーバースペック**: Agent SDK の本領はエージェントループ (ツール実行 / MCP / 複数ターン)。
  要約は「本文 → 要約 1 個」のステートレス 1 往復で、現行の直叩きが最小かつ正解。
- **コスト動機が弱い**: Haiku 4.5 で抜粋 6000 字 + 出力 300 tokens の要約は 1 クリップ
  概ね 1 円未満のオーダー。個人 RIL のクリップ頻度ではサブスク枠節約のメリットより
  常駐コンポーネント追加・アーキ改変のコストが上回る。デフォルトは Workers AI のまま (#16)。

> どうしてもサブスク枠で回したい場合は、要約を Worker の外 (常駐サーバ / ローカルバッチ) に
> 出して `claude` / Agent SDK を回す構成になるが、「1 req = 1 file 同期」の MVP 合意を崩し
> 常駐プロセスの運用負担を生むため、やるなら ADR を書いてから着手すること。

## 既知の制約 / 設計の前提

- Remotely Save は **暗号化なし**前提。OFF を切らないと Worker 直書きは効かない。
- iOS では Obsidian 起動時にしか pull されない。即時性は捨てている。
- 個人利用 1 名前提の Bearer 1 本認証。複数人化したら Cloudflare Access へ。
- Jina Reader の本文抽出はメディア記事には強いが、SPA で JS 後挿入の本文や
  paywall は取れない。代替経路として Cloudflare Browser Rendering を検討余地あり。
