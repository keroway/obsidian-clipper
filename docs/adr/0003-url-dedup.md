# ADR 0003: URL 重複検知

- Status: Accepted
- Date: 2026-06-17

## Context

同一 URL を複数回クリップすると同一内容のファイルが R2 に重複して蓄積される。
個人の Read It Later として既読 URL の重複は実用上の課題であり、
R2 上のインデックスファイルで重複を検知することで解決できる。

## Decision

**R2 の `${VAULT_PREFIX}${INBOX_FOLDER}/.index/urls.json` に `{ sha1(url): { path, createdAt } }` 形式のインデックスを持ち、重複 URL のクリップ時は新規ファイルを作成せず即座にエラーレスポンスを返す。**

理由:

1. R2 の追加バインディングが不要で既存の VAULT バインディングのみで完結する
2. SHA-1 は URL のハッシュ用途であり、暗号学的強度は不要。Web Crypto API (`crypto.subtle.digest`) で実装できる
3. インデックスファイル 1 本に集約することで Obsidian 側の vault に与える影響が最小

代替案として KV ストアの利用も検討したが、既存バインディングに追加が必要になるため採用しない。
排他制御は後勝ち（last-write-wins）とする。個人ツールで同時リクエストがほぼ発生しないため、R2 の if-match 制御は過剰と判断した。

## Consequences

- R2 オペレーションが 1 回増加（インデックス読み込み）。本文取得より十分高速であり問題ない
- `?refresh=1` で強制上書き保存できる（古いファイルは削除しない）
- インデックスファイル `.index/urls.json` は Remotely Save の sync 対象になるが、隠しフォルダ扱いで Obsidian 側には表示されない
