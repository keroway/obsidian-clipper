# Architecture Decision Records

機能追加・設計変更を行う前に、このディレクトリに ADR を追加してから実装に着手する。

## 採番・更新フロー

1. `0000-template.md` を `XXXX-<短いスラッグ>.md` にコピーし、直前の ADR 番号に +1 した 4 桁番号を付ける（例: 直前が `0001` なら `0002`）。
2. `Status: Proposed` で PR を出し、レビューで合意が取れたら `Accepted` に変更してマージする。
3. 後から決定を覆す場合は既存 ADR の `Status` を `Deprecated` または `Superseded by XXXX` に更新し、新しい ADR を起こす。既存ファイルは削除しない。

## 一覧

| 番号 | タイトル | Status |
|------|--------|--------|
| [0001](0001-introduce-vitest.md) | vitest + @cloudflare/vitest-pool-workers の導入 | Accepted |
| [0002](0002-adopt-biome.md) | Biome の採用 | Accepted |
| [0003](0003-url-dedup.md) | URL 重複検知 | Accepted |
| [0006](0006-failure-notification.md) | 失敗通知 (Webhook) | Accepted |
| [0007](0007-fetch-robustness.md) | 本文取得の堅牢化 (Jina フォールバック) | Accepted |
| [0008](0008-auto-tagging.md) | タグ自動付与 | Accepted |
