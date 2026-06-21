# ADR 0008: タグ自動付与

- Status: Accepted
- Date: 2026-06-21

## Context

現状の frontmatter の `tags` は `renderNote()` 内で
`unique(['clipped', ...payload.tags])` を組むだけで、ユーザがタグを送らないと
`clipped` のみになる。Obsidian / Dataview での分類が弱い。

タグを増やしたいが、frontmatter スキーマの `tags` キーと既定タグ `clipped` は
**Keep 移行スクリプトと共通**で、変えると Dataview クエリが壊れる
(CLAUDE.md「設計上の不変条件」)。よって「`tags` 配列に値を増やす」だけに留める。

## Decision

**ホスト名 allowlist による確実なタグと、本文がある場合のみ LLM が生成するタグ
(最大 3 個) を、既存のユーザ指定タグ + `clipped` に統合する。LLM 呼び出しは
`ENABLE_AUTO_TAG="true"` のときだけ行い、既定はオフ。失敗時は throw せず空配列に
degrade する。**

設計の要点:

1. **タグ統合はハンドラ側で完結**: `clipped` + ユーザタグ + allowlist タグ +
   LLM タグを `normalizeTag` で正規化 → 重複排除 → 最大件数で打ち切り、その結果を
   `renderNote({ tags })` に渡す。`renderNote()` のシグネチャ・`tags` 構築ロジック
   (`unique(['clipped', ...])`) は変更しない (二重付与は `unique` が吸収)。
2. **正規化 `normalizeTag`**: trim → 小文字化 → 空白をハイフン → Obsidian/Dataview で
   扱いにくい文字を除去 → 空なら捨てる。タグはファイル名には使わないが、安全文字に
   寄せる。
3. **allowlist `HOST_TAG_RULES`**: ホスト名サフィックス → 固定タグ
   (例: `zenn.dev` → `zenn`, `hatenablog.com` → `hatena`, `x.com` → `x`)。
   `hostname()` を流用して照合。LLM 不要で確実なため最優先で付与。
4. **LLM タグ `generateTags`**: `ENABLE_AUTO_TAG="true"` かつ本文ありのときのみ実行。
   要約と同じ provider 設計 (`SUMMARY_PROVIDER` / Anthropic フォールバック) を踏襲し、
   システムプロンプトで「カンマ区切り最大 3 個・一般的な技術タグ・固有名詞は短語化・
   タグのみ出力」を指示。失敗は `[]`。

却下した代替案:

- **`renderNote()` 内で自動タグを生成**: `renderNote` は純粋な整形関数 (テスト容易)
   に保ちたい。env / AI への依存を持ち込まず、統合はハンドラ側に置く。
- **要約呼び出しに相乗りしてタグも一括生成**: プロンプトが複雑になり、要約無効時
   (`ENABLE_SUMMARY=false`) にタグだけ欲しいケースに対応できない。独立呼び出しにする。
- **既定オン**: LLM 呼び出しコスト・レイテンシが全クリップに乗るため既定オフ。
   allowlist のみは LLM 不要なので常時有効。

## Consequences

- 新 env `ENABLE_AUTO_TAG` (既定 `"false"`) を追加。未設定なら従来どおり
   `clipped` + ユーザタグのみで、完全な後方互換。
- `ENABLE_AUTO_TAG="true"` 時は本文がある場合のみ LLM 呼び出しが 1 回増え、
   要約とは別にレイテンシ・コストが乗る。失敗は握り潰し `[]` に degrade
   (CLAUDE.md「失敗ポリシー」と整合)。
- allowlist は本文取得や LLM の成否に関わらず常に付与される (ホスト名だけで決まる)。
- `tags` キー名・`clipped` 既定タグ・frontmatter 構造は不変。Keep 移行 / Dataview
   互換を維持。
- allowlist はコード直書き (`HOST_TAG_RULES` 定数)。増えたら別ファイル化を検討。
</content>
