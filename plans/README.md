# Improvement Plans

This directory contains plans for improving the `obsidian-clipper` repository.

各 plan は着手前に `docs/adr/` の ADR とセットで運用する (CLAUDE.md「作業の進め方」参照)。

| #   | Plan                          | Status | Priority | Dependency |
| --- | ----------------------------- | ------ | -------- | ---------- |
| 001 | URL Duplicate Detection       | DONE   | High     | None       |
| 002 | Fetch Robustness (Jina fallback) | TODO | High   | None       |
| 003 | Auto Tagging                  | DONE   | Medium   | None       |

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

残る未実装は #7 観測性のみ。新規 plan はそこから起こすこと。

- ~~本文取得堅牢化 (HANDOFF #3) → **plan 002** (High)~~ DONE
- ~~タグ自動付与 (HANDOFF #4) → **plan 003** (Medium)~~ DONE
- 観測性 (HANDOFF #7) → 未起案 (Low、個人ツールでは優先度低。必要になったら plan 化)
</content>
</invoke>
