# Improvement Plans

This directory contains plans for improving the `obsidian-clipper` repository.

各 plan は着手前に `docs/adr/` の ADR とセットで運用する (CLAUDE.md「作業の進め方」参照)。

| #   | Plan                          | Status | Priority | Dependency |
| --- | ----------------------------- | ------ | -------- | ---------- |
| 001 | URL Duplicate Detection       | DONE   | High     | None       |
| 002 | Fetch Robustness (Jina fallback) | DONE | High   | None       |
| 003 | Auto Tagging                  | DONE   | Medium   | None       |
| 004 | README i18n & Tone Rework      | DONE   | Medium   | None       |
| 005 | Module Split + Shared Prompts (ADR 0009) | DONE | Medium | None |
| 006 | URL Index CAS + Duplicate Existence Check (ADR 0010) | DONE | Medium | 005 |

005 と 006 に対応する `plans/NNN-*.md` は存在しない。この 2 件は plan を書かずに
ADR 0009 / ADR 0010 へ直行したため、経緯はその ADR を読むこと。

## Status Legend

- TODO: Not started
- IN_PROGRESS: Currently being worked on
- DONE: Completed
- BLOCKED: Waiting on external factors or other plans

## 実装状況メモ (HANDOFF.md の TODO 候補との対応)

| HANDOFF TODO          | 状況      | 根拠                                          |
| --------------------- | --------- | --------------------------------------------- |
| 1. URL 重複検知       | DONE      | #37 (plan 001)                                |
| 2. 要約モデル切替     | DONE      | #10 (anthropic provider + workers-ai fallback)|
| 3. 本文取得の堅牢化   | DONE      | plan 002 / ADR 0007 (Jina retry + Browser Rendering) |
| 4. タグ自動付与       | DONE      | plan 003 / ADR 0008 (allowlist + LLM タグ)        |
| 5. 失敗通知 (Webhook) | DONE      | #38                                           |
| 6. テスト             | DONE      | #27 (vitest + vitest-pool-workers)            |
| 7. 観測性             | TODO      | 未実装                                        |

残る未実装は #7 観測性のみ。新規 plan はそこから起こすこと (現時点では実運用上の必要性が
確認できていないため、将来検討事項として据え置く。plan化は必要になった時点で行う)。

- ~~本文取得堅牢化 (HANDOFF #3) → **plan 002** (High)~~ DONE
- ~~タグ自動付与 (HANDOFF #4) → **plan 003** (Medium)~~ DONE
- 観測性 (HANDOFF #7) → 未起案 (Low、個人ツールでは優先度低。必要になったら plan 化)

## 全体見直し Phase 2/3 (2026-07-11)

コードベース全体見直しの一環として以下を実施 (ADR 0009 / 0010)。

- **plan 005 (モジュール分割)**: `src/index.ts` の肥大化解消と、
  `scripts/compare-summary-models.ts` へのプロンプト手動コピー同期負債を解消。
  振る舞い不変のリファクタリング。
- **plan 006 (URL インデックス堅牢化)**: R2 の条件付き PUT (`onlyIf`) による
  楽観ロックで lost update を解消し、重複判定時に `head()` で実ファイル存在を
  確認するように変更 (仕様変更: Inbox から削除/移動済みの URL は重複とみなさず
  再クリップを許可)。
