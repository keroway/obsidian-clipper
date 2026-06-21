# 001-url-duplicate-detection.md

> **Status: DONE** — 実装済み (commit `830c7bd` feat: URL 重複検知を実装する (#33) (#37))。
> `src/index.ts` の `sha1Hex` / `readUrlIndex` / `writeUrlIndex` と `/clip` ハンドラの重複検知ブロック、
> および `src/index.test.ts` の `POST /clip - duplicate detection` でカバー済み。本ファイルは記録として残置。

## Description
Implement URL duplicate detection to prevent multiple entries for the same URL in the R2 bucket.

## Context
Currently, the `obsidian-clipper` pipeline creates a new entry for every `POST /clip` request, even if the URL has been processed before. To avoid clutter in the Obsidian vault, we should check if a URL has already been clipped.

## Goals
- Store a mapping of `sha1(url)` to its metadata in an R2 object (e.g., `Inbox/.index/urls.json`).
- Check this mapping before processing a new clip.
- If a duplicate is found, return a `200 OK` with a "duplicate" status (or similar) instead of creating a new file.
- Support a `?refresh=1` query parameter to allow overwriting existing clips.

## Requirements
- Use `sha1` for URL hashing to ensure consistency.
- The `.index/urls.json` should be managed atomically (R2 doesn't have transactions, so we need to handle potential race conditions or accept eventual consistency).
- Maintain compatibility with the existing `VAULT_PREFIX` and `INBOX_FOLDER` variables.

## Implementation Steps
1. **Dependency Check**: Ensure `crypto` or a compatible library is available for SHA1 hashing.
2. **Hashing Utility**: Add a utility function to compute `sha1(url)`.
3. **R2 Index Management**:
    - Create a helper to read/write the `.index/urls.json` file.
    - If the file doesn't exist, create it.
    - If it exists, read, update the hash mapping, and write back.
4. **Update `/clip` Handler**:
    - Extract `refresh` parameter from the URL.
    - Compute hash of the incoming URL.
    - Check if hash exists in the R2 index.
    - If exists and `refresh != 1`, return early with success and a message that it's a duplicate.
    - If it doesn't exist (or `refresh == 1`), proceed with the existing pipeline and update the index with the new path.
5. **Metadata Storage**: Store the path and `createdAt` timestamp in the index.

## Verification
- **Test Case 1 (New URL)**:
  `curl -X POST http://127.0.0.1:8787/clip -H "Authorization: Bearer <SECRET>" -d '{"url":"https://example.com/1"}'`
  - Expect: `200 OK` and file created in R2.
- **Test Case 2 (Duplicate URL)**:
  `curl -X POST http://127.0.0.1:8787/clip -H "Authorization: Bearer <SECRET>" -d '{"url":"https://example.com/1"}'`
  - Expect: `200 OK` and NO new file created.
- **Test Case 3 (Refresh)**:
  `curl -X POST 'http://127.0.0.1:8787/clip?refresh=1' -H "Authorization: Bearer <SECRET>" -d '{"url":"https://example.com/1"}'`
  - Expect: `200 OK` and new file created (overwriting the old one in the vault).
  - 注: `refresh` は **クエリ文字列** (`?refresh=1`) で渡す。実装は `c.req.query('refresh')` を読むため、body に混ぜると無効。

## Maintenance Notes
- Be aware of R2's eventual consistency. For a personal tool, this is usually acceptable.
- The `.index/urls.json` file could grow large over time. Consider a strategy for cleanup if it exceeds R2 limits (unlikely for a personal vault).

## Drift Detection
- Commit: `$(git rev-parse --short HEAD)`
- Plan was written against this commit.
