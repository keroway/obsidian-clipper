# セキュリティポリシー / Security Policy

## サポート対象

個人運用の MVP のため、サポート対象は **`main` ブランチの最新コミットのみ**です。
過去のタグ / リリースに対する個別のセキュリティ修正は行いません。

## 脆弱性の報告

このリポジトリでは GitHub の **Private vulnerability reporting** を有効にしています。
脆弱性を見つけた場合は、公開 Issue を立てず、以下から非公開で報告してください:

- リポジトリの **Security** タブ → **Report a vulnerability**
  (直接リンク: <https://github.com/keroway/obsidian-clipper/security/advisories/new>)

可能であれば以下を含めてください:

- 影響の概要と再現手順
- 想定される影響範囲 (情報漏えい / 認証バイパス / 任意の Vault 書き込み 等)
- 確認した環境 (ローカル `wrangler dev` / 本番 deploy)

solo 運用のためベストエフォート対応です。受領の確認・対応方針の連絡まで数日いただく場合があります。

## 想定する脅威と注意点

このプロジェクト特有の、特に注意している点:

- **`SHARED_SECRET`**: `/clip` は Bearer 認証のみで保護される。漏えいすると任意の URL を Vault に書き込まれる。Issue / PR / ログに secret を貼らないこと。
- **`JINA_API_KEY` / `ANTHROPIC_API_KEY`**: Wrangler secret として投入する。コードや設定ファイルにハードコードしない (`wrangler.jsonc` の vars には置かない)。
- **CORS は `*`**: ブックマークレット / iOS ショートカットから叩く前提。認証は Bearer トークンに依存している。
- **R2 直書き**: Worker は Remotely Save と同じバケットへ直接書き込む。Remotely Save 側の暗号化は OFF 前提 (README 参照)。

secret の混入は GitHub Secret Scanning + push protection と CI の gitleaks で二重に検知する構成です。
