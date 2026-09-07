# reusable workflow の SHA ピン化と更新手順

`.github/workflows/` から `keroway/.github` の reusable workflow を呼び出す箇所は、
可変参照の `@main` ではなく `keroway/.github` の commit SHA に固定している
（keroway/.github#17）。`@main` のままだと、呼び出し元を変更しなくても
`keroway/.github` 側の `main` 更新で次回実行時の検査・ラベル除去ロジックが変わってしまう。

対象:

- `.github/workflows/gitleaks.yml`
- `.github/workflows/osv-scan.yml`
- `.github/workflows/workflow-lint.yml`

## SHA の更新手順

1. `keroway/.github` の変更内容を確認する。
   ```bash
   gh api repos/keroway/.github/commits/main --jq '.sha, .commit.message'
   ```
2. 対象コミットの diff をレビューする (`gh api repos/keroway/.github/commits/<SHA>`
   や `git -C ../keroway/.github log -p` で内容を確認)。
3. レビュー済みの SHA で、上記ファイルの `uses:` 行末尾を更新する
   (`@<旧SHA>` → `@<新SHA>`)。コメントの日付・要約も合わせて更新する。
4. リポジトリの通常の検証（lint / typecheck / test 相当）を通す。
5. PR を作成し、CI が green であることを確認してからマージする。

`keroway/.github` 側は個人アカウント配下の自前リポジトリのため Dependabot の
GitHub Actions エコシステム更新は対象外 (別オーナー・別リポジトリの reusable
workflow のみ追従する)。SHA の追従は上記の手動手順に依る。
