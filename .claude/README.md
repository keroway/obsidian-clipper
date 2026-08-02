# obsidian-clipper — Claude Code Setup

このディレクトリは Claude Code の共有設定です。リポジトリルートの
`CLAUDE.md` と一緒に読んでください。Codex / pi では、共通指示は `AGENTS.md`
（`CLAUDE.md` への symlink）に置き、各ハーネス固有の設定・hook は対応する
公式ドキュメントに読み替えます。

## 構成

```text
.claude/
├── hooks/
│   └── post-stop-check.sh     # Stop: 変更範囲に応じた決定的検証
├── settings.json               # 共有設定（コミット対象）
├── settings.local.json         # 個人設定（.gitignore で除外）
└── README.md                   # この設定の説明書
```

存在しない `agents/`、`commands/`、`rules/` は列挙しない。追加したら役割をここへ記録する。

## 依存ツール

| ツール | 用途 | 必須？ |
|---|---|---|
| `bun` | lint / typecheck / test | 必須（Stop hook は無ければ exit 2） |
| `jq` | hook payload の JSON 抽出 | 任意（フォールバックあり） |

## Hooks の挙動 `[Claude Code]`

### Stop: `post-stop-check.sh`

- 発火条件: Claude Code の応答完了時（変更がなければ即終了）
- 動作: uncommitted / untracked / unpushed の変更を分類し、CI
  (`.github/workflows/{lint,typecheck,test}.yml`) と同じ
  `bun run lint` / `bun run typecheck` / `bun run test` を必要な範囲だけ実行
- 失敗時: exit 2。bun 不在など「検証できない」場合も silent-pass しない
- 一時的に止めたい場合: `CLIPPER_SKIP_STOP_HOOK=1`

## Rules の参照階層

`CLAUDE.md`（最上位・`AGENTS.md` は symlink） → `docs/adr/`（機能追加時の設計判断）の順で参照する。
矛盾があれば **`CLAUDE.md`** が優先する。

## 他環境への移植

- hook は `#!/usr/bin/env bash` を使う
- 絶対パスは `$CLAUDE_PROJECT_DIR` または `git rev-parse --show-toplevel` で解決する
- `settings.local.json`、作業メモ、worktree は `.gitignore` で除外する

新しい開発者がクローン後に必要な追加手順: `bun install`（`prepare` スクリプトで
`lefthook install` も自動実行され、pre-commit フックが有効化される）。
