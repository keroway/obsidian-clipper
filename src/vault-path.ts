// R2 キーの prefix 正規化 (#411)。
// VAULT_PREFIX は「空文字 or 末尾スラッシュ付き」が前提だが、`MyVault` のように
// 末尾スラッシュを忘れても `MyVaultInbox/...` という Vault 外のキーへ黙って保存しないよう、
// 先頭スラッシュを除去し、空でなければ末尾スラッシュを補完する。

export function resolveVaultPrefix(raw: string | undefined): string {
  const trimmed = (raw || '').replace(/^\/+/, '')
  if (trimmed === '') return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}
