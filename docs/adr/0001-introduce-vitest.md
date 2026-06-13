# ADR 0001: vitest + @cloudflare/vitest-pool-workers の導入

- Status: Accepted
- Date: 2026-06-13

## Context

obsidian-clipper は Cloudflare Worker (Hono + TypeScript strict) として実装されており、
`normalizeUrl` / `sanitizeForFilename` / `renderNote` などのユーティリティ関数と
`POST /clip` エンドポイントが核となる。

これまでテストは未導入だったが、HANDOFF.md に以下の指針が明記されている:

> テスト導入の場合は vitest + `@cloudflare/vitest-pool-workers`、
> Jina / Workers AI は MSW 相当でモック

CI は既に TypeScript の型チェック (typecheck.yml) が存在しており、
テストジョブを追加することで品質ゲートを強化する。

## Decision

**vitest + @cloudflare/vitest-pool-workers を採用する。**

理由:

1. **Worker ランタイム互換性**: `@cloudflare/vitest-pool-workers` は Miniflare ベースの
   Workerd ランタイムでテストを実行する。Node.js 環境では存在しない `R2Bucket` / `Ai` /
   `fetch` のグローバル差異をそのまま扱えるため、本番に近いテストが書ける。

2. **バインディングのモック機構**: `cloudflare:test` モジュールが提供する `env` オブジェクトを
   使うことで、R2・AI・secrets を実際のリソースなしにモックでき、
   統合テスト (`POST /clip`) を CI で安全に実行できる。

3. **wrangler.jsonc との直結**: `wrangler: { configPath: "./wrangler.jsonc" }` を指定するだけで
   バインディング定義・compatibility_flags が引き継がれる。設定の二重管理が不要。

4. **HANDOFF.md 既定の技術選定**: プロジェクト引継ぎ文書で明示的に推奨されており、
   将来の保守担当者が迷わない。

5. **bun との相性**: `bun run vitest` / `bun add -d vitest` が問題なく動作する。

Jest は Node.js ランタイム向けのため Worker 専用グローバルのモックが煩雑になる。
また Miniflare を直接使う構成は vitest-pool-workers より設定量が多く、採用しない。

## Consequences

- **追加 devDependency**: `vitest`, `@cloudflare/vitest-pool-workers`
- **追加ファイル**: `vitest.config.ts`, `src/index.test.ts`
- **既存コードへの変更**: ユーティリティ 3 関数 (`normalizeUrl`, `sanitizeForFilename`,
  `renderNote`) に `export` を追加。アプリ動作は変わらない。
- **CI 追加**: `.github/workflows/test.yml` でテストジョブが走る。typecheck と並列実行。
- **注意**: `renderNote` の引数シグネチャや frontmatter キー名を変更すると
  テストが壊れる。CLAUDE.md の「設計上の不変条件」と合わせてロックされた仕様として扱う。
