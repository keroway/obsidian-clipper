// Cloudflare Worker のバインディング・環境変数型。
// 循環 import を避けるため、他モジュールから参照される型だけをここに置く。
export type Bindings = {
  VAULT: R2Bucket
  AI: Ai
  SHARED_SECRET: string
  VAULT_PREFIX: string
  INBOX_FOLDER: string
  // 画像添付の保存先フォルダ (既定 'Attachments')。ADR 0011。
  ATTACHMENTS_FOLDER?: string
  // 画像添付の最大バイト数 (既定 10MiB)。ADR 0011。
  MAX_IMAGE_BYTES?: string
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
