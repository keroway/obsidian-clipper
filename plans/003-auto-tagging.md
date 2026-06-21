# 003-auto-tagging.md

> **Status: DONE** / Priority: Medium / Dependency: None
> HANDOFF.md TODO #4「タグ自動付与」に対応。
> 実装済み: ADR `docs/adr/0008-auto-tagging.md`、`src/index.ts` の `HOST_TAG_RULES` /
> `normalizeTag` / `mergeTags` / `hostTagsFor` / `generateTags`、ハンドラのタグ統合、
> `src/index.test.ts` の tags 単体 + `POST /clip - auto tagging` 統合テスト。

## Description

本文 + URL ホスト名から、ユーザ指定タグに加えて自動タグを最大 3 個付与する。
allowlist (ホスト名 → 固定タグ) と LLM 生成を併用する。

## Context

現状 `renderNote()` の frontmatter は `unique(['clipped', ...payload.tags])` のみ。
ユーザがタグを送らないと `clipped` だけになり、Dataview での分類が弱い。

frontmatter スキーマ (`tags`) は **Keep 移行スクリプトと共通**であり、キー名や
`clipped` の存在を壊すと既存クエリが破綻する (CLAUDE.md「設計上の不変条件」)。
よって本 plan は「`tags` 配列に値を増やす」だけに留め、構造は変えない。

## Goals

- ホスト名 allowlist で確実なタグを付与 (例: `zenn.dev` → `zenn`,
  `*.hatenablog.com` → `hatena`, `x.com` → `x`)。
- 本文がある場合のみ、LLM で内容ベースのタグを最大 3 個生成 (日本語/英単語短語)。
- 既存の `clipped` + ユーザ指定タグ + allowlist + LLM タグを統合し、
  正規化 (小文字化・記号除去・重複排除) して最大件数で打ち切る。
- LLM 失敗・要約無効時は allowlist + ユーザタグだけで成立 (degrade)。

## Requirements

- **`tags` のキー名・`clipped` 既定タグを変えない** (Keep 移行/Dataview 互換)。
- タグは `INVALID_FILENAME_RE` 相当の危険文字を含めない (ファイル名には使わないが
  Obsidian/Dataview で扱いやすい安全文字に正規化)。空白はハイフン化。
- LLM 呼び出しは要約と同じ provider 設計を踏襲 (`SUMMARY_PROVIDER`) するか、
  独立 env `ENABLE_AUTO_TAG` でオン/オフ。既定オフで後方互換を保つ。
- 失敗時は throw せず空配列に degrade (CLAUDE.md「失敗ポリシー」と整合)。
- Wrangler v4 / Hono ^4 / TypeScript strict 維持。

## Implementation Steps

1. **ADR**: `docs/adr/` に「自動タグ付与方式」。LLM 呼び出しを要約に相乗りさせるか
   別呼び出しにするか (コスト/レイテンシ)、allowlist の持ち方を決める。
2. **allowlist**: `HOST_TAG_RULES` 定数 (ホスト名/サフィックス → タグ) を `src/index.ts`
   に追加。`hostname()` を流用して照合。
3. **正規化**: `normalizeTag(s)` を追加 (trim → lower → 空白→`-` → 危険文字除去 →
   空なら捨てる)。`unique` と組み合わせる。
4. **LLM タグ生成**: `ENABLE_AUTO_TAG === 'true'` かつ本文ありのとき
   `generateTags(env, md, title)` を実装。system prompt で「カンマ区切り最大3個・
   一般的な技術タグ・固有名詞は短語化」を指示。失敗は `[]`。
5. **統合**: ハンドラで
   `tags = unique(['clipped', ...userTags, ...hostTags, ...llmTags].map(normalizeTag).filter(Boolean)).slice(0, N)`。
   `renderNote()` の呼び出しに渡す (renderNote 自体のシグネチャは変えない)。
6. **env 反映**: `wrangler.jsonc` vars / `Bindings` 型 / README に `ENABLE_AUTO_TAG`。

## Verification

- **Unit**: `normalizeTag` (空白/大文字/記号/空) と allowlist 照合 (`zenn.dev`,
  サブドメイン, 非マッチ) を検証。
- **Unit**: `generateTags` を LLM モックで「3個生成」「4個以上→3個に切り詰め」
  「失敗→[]」を検証。
- **Integration**: `ENABLE_AUTO_TAG=true` で `POST /clip` の保存ノート frontmatter に
  `clipped` + 自動タグが入り、キー名/構造が不変なことを確認。
- **回帰**: `ENABLE_AUTO_TAG` 未設定なら従来どおり `clipped` + ユーザタグのみ。

## Maintenance Notes

- allowlist はコードに直書きで十分 (個人ツール)。増えたら別ファイル化を検討。
- LLM タグの品質が低ければ allowlist 優先・LLM は補助に倒す。

## Drift Detection

- Commit: `0fb41e6`
- Plan was written against this commit. 実装前に `renderNote()` の `tags` 構築箇所
  (`unique(['clipped', ...])`) が変わっていないか確認すること。
</content>
