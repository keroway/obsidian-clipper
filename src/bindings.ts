// Cloudflare Worker のバインディング・環境変数型。
// 循環 import を避けるため、他モジュールから参照される型だけをここに置く。
export type Bindings = {
  VAULT: R2Bucket
  AI: Ai
  SHARED_SECRET: string
  VAULT_PREFIX: string
  INBOX_FOLDER: string
  ENABLE_SUMMARY: string
  SUMMARY_MODEL: string
  ENABLE_AUTO_TAGS?: string
  // 後方互換: 旧名 (単数)。ENABLE_AUTO_TAGS が優先。
  ENABLE_AUTO_TAG?: string
  // ホスト名 → 固定タグの allowlist。'zenn.dev:zenn,github.com:github' 形式。
  // 既定ルールに追記マージされる (未設定でも既定ルールは有効)。
  AUTO_TAGS_ALLOWLIST?: string
  JINA_API_KEY?: string
  SUMMARY_PROVIDER?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  NOTIFY_WEBHOOK_URL?: string
  CF_ACCOUNT_ID?: string
  BROWSER_RENDERING_API_TOKEN?: string
}
