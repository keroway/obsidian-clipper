// This file declares the global Cloudflare.Env interface used by
// @cloudflare/vitest-pool-workers for binding types in tests.
// It mirrors the Bindings type declared in src/index.ts.
declare namespace Cloudflare {
  interface Env {
    VAULT: R2Bucket
    AI: Ai
    SHARED_SECRET: string
    VAULT_PREFIX: string
    INBOX_FOLDER: string
    ENABLE_SUMMARY: string
    SUMMARY_MODEL: string
    JINA_API_KEY?: string
    SUMMARY_PROVIDER?: string
    ANTHROPIC_API_KEY?: string
    ANTHROPIC_MODEL?: string
  }
}
