# 004-readme-i18n-and-tone.md

> **Status: DONE** / Priority: Medium / Dependency: None
> README と GitHub の About (repository description) の見直し。
> このファイルは「実装計画」であり、実装そのものは別エージェント/モデルに委譲する。

## Description

現在の `README.md` は日本語のみで、絵文字が多く、いわゆる "AI が書いたような"
誇張気味・テンプレ的な表現が目立つ。本リポジトリは技術者向けのセルフホスト
リファレンス実装であり、ユーザー層は国内より海外 (英語圏) のほうが厚いと見込まれる。

そこで次の 2 点を行う:

1. **デフォルト README を英語化**し、日本語版を別ファイルに残して相互リンクする。
2. **トーンを自然な技術文書に寄せる** — 絵文字を削減し、誇張・マーケ的表現を排し、
   事実ベースの簡潔な記述にする。

GitHub の About (repository description) も同方針で英語の簡潔な一文に整える。

## Context

- 現状の `README.md` (542 行, 日本語) が唯一の README。トップに 12 個のバッジ、
  本文に多数の絵文字 (特に「特徴」セクションと 2 つの Mermaid 図)。
- リポジトリ description は現在:
  `Cloudflare Worker (Hono) that clips web pages into an Obsidian vault on R2`
  (既に英語・簡潔なので大きな変更は不要。下記 Goals 参照)。
- プロジェクトの設計不変条件は `CLAUDE.md` に集約されている。README の文言を
  変えても、そこに書かれた事実 (frontmatter スキーマ / JST 固定 / 暗号化 OFF /
  `VAULT_PREFIX` 末尾スラッシュ等) を曲げてはならない。
- 既存の相互リンク慣習: README から `HANDOFF.md` / `client/*.md` / `LICENSE` /
  `.github/*` などへ相対リンクしている。i18n 版もこの相対リンク方式を踏襲する。

## Goals

- **`README.md` を英語のデフォルトにする。** 内容は現行日本語版と同等の情報量を保つ
  (セットアップ手順・API/設定リファレンス・既知の制約などを欠落させない)。
- **`README.ja.md` (日本語版) を新設**し、現行 README の日本語内容を移植する。
  トーン改善 (絵文字削減・誇張排除) は日本語版にも適用する。
- **相互リンク**: 両ファイルの先頭に言語切替リンクを置く。
  - 英語: `English | [日本語](./README.ja.md)`
  - 日本語: `[English](./README.md) | 日本語`
- **トーン方針** (両言語共通):
  - 絵文字を原則排除。見出し・箇条書き・Mermaid 図のノード装飾から絵文字を外す
    (Mermaid のノードラベルは絵文字なしのテキストに置換)。
  - "1 タップで"" 最小実装"" 読みきれるサイズ" のような主観的・マーケ的形容を、
    事実 (対応クライアント、行数の実数など) に置き換えるか削除する。
  - バッジは情報量のあるものに絞る (例: License, 主要ランタイム程度。12 個は多い)。
    削る/残すの線引きは実装者判断でよいが、"装飾目的のみ" のバッジは落とす方向。
  - 箇条書きの太字乱用 (`**...**` の多用) を抑え、素直な文に直す。
- **About (description)** を英語の簡潔な一文に保つ。現行で概ね良いが、
  "AI summary / self-hosted / reference implementation" のニュアンスを 1 つ含めると
  リポジトリの性質が伝わりやすい。例 (実装者が最終調整):
  `Self-hosted Cloudflare Worker that saves web pages as Markdown (with optional AI summary) into an Obsidian vault on R2`
  反映は `gh repo edit keroway/obsidian-clipper --description "..."` で行う
  (権限のあるオーナーが実行、または手順を提示)。

## Non-Goals

- 機能・コード (`src/`) の変更は行わない。ドキュメントのみ。
- 翻訳の完全 1:1 同期の自動化 (CI チェック等) は本 plan の範囲外。
- README 以外のドキュメント (`HANDOFF.md` / `SECURITY.md` / `client/*.md`) の
  英語化は対象外 (必要なら別 plan)。ただし README からのリンクは壊さないこと。

## Requirements

- `CLAUDE.md` の「設計上の不変条件」に書かれた事実と矛盾する記述を新たに作らない。
  特に: frontmatter キー名、JST 固定、Remotely Save 暗号化 OFF、`VAULT_PREFIX`
  末尾スラッシュ、`INVALID_FILENAME_RE` の安全部分集合、失敗時 200 ポリシー。
- 英語版と日本語版で**情報の不整合を作らない** (バージョン番号・既定値・コマンドは一致)。
  設定リファレンスの表 (env / secret / binding) は両版で同じ値を持つこと。
- 既存の相対リンク (`./HANDOFF.md`, `./client/...`, `./LICENSE`,
  `.github/workflows/gitleaks.yml` 等) を移植後も有効に保つ。
- Mermaid 図はレンダリングが壊れないこと (絵文字除去後も GitHub で表示可能)。
- 目次 (TOC) のアンカーリンクを各言語の見出しに合わせて更新する
  (英語見出しに変えたらアンカーも英語化)。

## Implementation Steps

1. **日本語版を分離**: 現行 `README.md` をベースに `README.ja.md` を作成。
   先頭に言語切替リンクを追加。絵文字削減・トーン改善をこの版にも適用。
2. **英語版を作成**: `README.md` を英語で書き直す。日本語版と同じ章立て・同じ
   情報量を保ちつつ、自然な技術英語にする。先頭に言語切替リンク。
3. **TOC / アンカー**: 英語見出しに合わせて目次のリンクを貼り直す。日本語版も同様。
4. **バッジ整理**: 装飾過多なバッジを削減 (両版共通の方針)。
5. **Mermaid**: 2 つの図のノードラベルから絵文字を除去し、テキストラベルに置換。
   両版で図を共有してよい (図中の説明テキストは英語化推奨だが、最低限崩れないこと)。
6. **About 更新**: description を英語一文に調整。`gh repo edit` コマンドを実行するか、
   オーナー向けに手順とコマンドを README 作業の最後に提示する。
7. **リンク検証**: 両 README 内の相対リンク・アンカーリンクが切れていないか確認。

## Verification

- `README.md` が英語、`README.ja.md` が日本語で、両者が相互リンクされている。
- 両版で env/secret/binding の表・既定値・CLI コマンドが一致している
  (差分を grep で突き合わせる: 既定値文字列・モデル ID・コマンドの一致確認)。
- README 内の絵文字が原則ゼロ (Mermaid ノード含む)。
  確認例: `rg -n "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" README.md README.ja.md` が
  ほぼ何も返さない (許容する絵文字があれば plan に明記)。
- GitHub プレビューで両 README の Mermaid 図が壊れずレンダリングされる。
- 相対リンク先 (`HANDOFF.md` / `client/*.md` / `LICENSE` / `.github/...`) が存在し、
  リンク切れがない。
- About が英語の簡潔な一文に更新されている (反映できない場合はコマンドが提示済み)。

## Maintenance Notes

- 以後 README を更新する際は英日両方を更新する運用にする (本 plan では自動同期は入れない)。
  必要になったら "翻訳ドリフト検知" を別 plan 化する。
- 新規バッジを足す場合も「情報量のあるものだけ」の方針を継続する。

## Drift Detection

- Commit: `ba610d4`
- この plan は上記コミットの `README.md` (542 行) を前提に書かれている。
  実装前に `README.md` と `CLAUDE.md`「設計上の不変条件」に差分がないか確認すること。
