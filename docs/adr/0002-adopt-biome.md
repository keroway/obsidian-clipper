# ADR 0002: Biome lint/format の採用

- Status: Accepted
- Date: 2026-06-16

## Context

obsidian-clipper は TypeScript strict で書かれた Cloudflare Worker であり、
現状の静的解析は `tsc --noEmit`（型チェック）のみ。
コードスタイルの統一と lint 違反の自動検出に対応するツールが不在で、
PR レビューで指摘が属人化しやすい状態だった。

親 issue #26（横断ノウハウ展開）において、姉妹リポジトリ `keroway/astro-blog` が
Biome を採用済みであることが確認され、本リポジトリへの展開が検討対象となった。

CLAUDE.md の運用ルールに従い、ADR で採否を判断してから実装する。
依存先 #29（ADR テンプレート整備）は PR #31 でマージ済み。

## Decision

**Biome を採用し、lint / format を整備する。**

理由:

1. **単一ツールで完結**: lint と format を `@biomejs/biome` 1 パッケージで賄える。
   ESLint + Prettier の組み合わせと比べてツール間の設定整合を管理する必要がなく、
   `bunfig.toml` の `minimumReleaseAge` ポリシー下での依存数増加も抑えられる。

2. **高速**: Biome は Rust 製で、ファイル数の少ない本リポジトリでは体感差は小さいが、
   CI のコールドスタート時間短縮に寄与する。

3. **横断保守の容易さ**: `keroway/astro-blog` と同一ツールを採用することで、
   lint ルールや CI ジョブ設定の横断展開・更新が 1 か所の参照で済む。

4. **formatter スタイルの柔軟性**: Biome は `quoteStyle` / `semicolons` を個別設定できるため、
   既存コードの single quote / セミコロンなしスタイルを維持でき、
   採用時の再フォーマット diff を最小化できる。

却下した代替案:

- **ESLint + Prettier**: ツールが 2 つになる上に eslint-config-prettier など
  統合 plugin が必要になる。依存数が増えるほど `minimumReleaseAge`（7日）gate で
  緊急 patch 適用のための `minimumReleaseAgeExcludes` 管理が煩雑になる。
  本リポジトリの規模感では Biome 1 ツールで要件を満たすため不採用。

- **何もしない（typecheck のみ維持）**: コードスタイル違反が PR レビューの指摘事項に
  留まり、自動化による省力化の機会を逃す。横断展開の文脈でも一貫性を欠く。

## Consequences

- **追加 devDependency**: `@biomejs/biome`
- **追加ファイル**: `biome.json`（lint/format 設定）, `.github/workflows/lint.yml`
- **`package.json` 変更**: `lint` / `format` / `check` script を追加
- **CLAUDE.md 変更**: `bun run lint` を開発コマンドとして追記
- **既存コードへの影響**: formatter スタイルを既存に揃えるため、実質的な変更は
  `organizeImports` による import 並び替えのみ（src/index.ts 等の hono import 群）
- **CI 追加**: `.github/workflows/lint.yml` で Biome CI チェックが走る。
  typecheck / test と独立したジョブで並列実行されるため、既存 CI へのパス影響はない。
- **注意**: `biome.json` の `files.includes` は `src/**/*.ts` / `scripts/**/*.ts` /
  `vitest.config.ts` に限定。`wrangler.jsonc` 等のコメント付き JSONC は
  CLAUDE.md の不変条件を保護するため対象外とする。
