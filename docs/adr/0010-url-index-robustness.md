
# ADR 0010: URL インデックスの整合性強化と重複判定の仕様変更

- Status: Accepted
- Date: 2026-07-11

## Context

現行の重複検知 (`.index/urls.json`) は read → mutate → put の非アトミックな
read-modify-write で、同時リクエストが来ると後勝ちで前の更新が失われる
(lost update)。また note の R2 PUT が成功した後に index の PUT が失敗すると、
ファイルは保存されているのに index に載らず、以後同じ URL が重複検知されない
まま再クリップされ続ける。

さらに、index が「保存済み」と記録している URL でも、実際には Obsidian 側で
Inbox から移動・削除済みのファイルを指している可能性がある。現行実装は
`urlIndex[hash]` の存在だけで `duplicate: true` を返しており、ファイルが
既に存在しない場合でも「重複」として新規保存を拒否してしまう。

個人利用のツールであり同時リクエストの発生頻度は低いが、無視できるリスクでは
ない。R2 の条件付き PUT (`onlyIf: { etagMatches / etagDoesNotMatch }`) を
使うことで、追加のインフラなしに楽観的ロックを実現できる。

## Decision

**index の書き込みを R2 の条件付き PUT による楽観ロック (CAS: read → put
onlyIf etag → 競合時は再読込して 1 回だけリトライ) に変更する。また重複判定時
に対象ファイルの実在を `R2Bucket.head()` で確認し、存在しない場合は重複扱いせず
新規保存を許可する。**

設計の要点:

1. **CAS 書き込み**: `readUrlIndex` は index に加えて R2 オブジェクトの
   `etag` を返す。書き込みは `vault.put(key, json, { onlyIf: etag ?
   { etagMatches: etag } : { etagDoesNotMatch: '*' } })` とし、`null` が
   返る (プリコンディション不一致 = 競合) 場合は index を再読込してから
   1 回だけ再試行する。最終試行でも競合する場合は可用性を優先し、無条件
   PUT にフォールバックする (個人ツールでの稀な lost update は許容する)。
2. **重複判定 + 実在確認**: `!refresh && urlIndex[hash]` が真の場合、
   `vault.head(urlIndex[hash].path)` で対象オブジェクトの実在を確認する。
   存在すれば従来通り `duplicate: true` を返す。存在しなければ (Inbox から
   移動/削除済み) 重複とはみなさず、通常の新規保存フローを継続する。
   **これは仕様変更である**: 従来は「一度クリップした URL は index に残る
   限り二度と保存しない」だったが、変更後は「Inbox に現存する限り重複と
   みなす」になる。Read It Later ツールとしては後者がより自然な挙動と判断
   した。

却下した代替案:

- **per-URL マーカーオブジェクト方式** (`.index/<sha1>` を 1 URL 1
  オブジェクトに分割): 競合・肥大読み込みが構造的に解消するが、既存
  `urls.json` 形式からの移行が必要になり個人ツールにはオーバースペック。
  index が今後数千件規模になった場合に再検討する。
- **重複時に実在確認をしない (現状維持)**: 実装コストは最小だが、
  「Inbox から消した URL を二度とクリップできない」という直感に反する挙動を
  残すことになるため採用しない。

## Consequences

- `src/url-index.ts` (ADR 0009 の分割後) の `readUrlIndex` / `writeUrlIndex`
  のシグネチャを変更する (etag を伴う CAS 版に置き換え)。
- 重複判定時に `head()` の R2 サブリクエストが 1 回増える (重複ヒット時のみ)。
  通常の新規保存フローには影響しない。
- 重複検知の挙動が変わるため README / CLAUDE.md の該当説明を更新する。
- miniflare (vitest-pool-workers) で `onlyIf` / `head` が本番同等に動作する
  ことをテストで確認する。
