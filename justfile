# keroway 標準 justfile（bun リポジトリ版）。
# 中身は package.json scripts への薄い委譲のみにする。

default:
    @just --list

test:
    bun run test

lint:
    bun run lint

format:
    bun run format

typecheck:
    bun run typecheck

# lint / typecheck / test をまとめて実行（コミット前の全通し確認）
check:
    bun run lint
    bun run typecheck
    bun run test
