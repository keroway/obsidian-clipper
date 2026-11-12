// R2 キーの prefix 正規化 (#411)。
// VAULT_PREFIX は「空文字 or 末尾スラッシュ付き」が前提だが、`MyVault` のように
// 末尾スラッシュを忘れても `MyVaultInbox/...` という Vault 外のキーへ黙って保存しないよう、
// 先頭スラッシュを除去し、空でなければ末尾スラッシュを補完する。

// 保存先フォルダ (INBOX_FOLDER / ATTACHMENTS_FOLDER) の正規化 (#415)。
// 前後スラッシュを除去し、`///` のように除去後が空になる設定は既定フォルダへ復帰させる
// (空のまま連結すると `/xxx.md` や `MyVault//xxx.md` の不正キーになるため)。
export function resolveFolder(
  raw: string | undefined,
  fallback: string,
): string {
  const trimmed = (raw || '').replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? fallback : trimmed
}

export function resolveVaultPrefix(raw: string | undefined): string {
  const trimmed = (raw || '').replace(/^\/+/, '')
  if (trimmed === '') return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}
