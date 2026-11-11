import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { resolveVaultPrefix } from './vault-path'

describe('resolveVaultPrefix (#411)', () => {
  it('空 / 未設定は空文字', () => {
    expect(resolveVaultPrefix(undefined)).toBe('')
    expect(resolveVaultPrefix('')).toBe('')
    expect(resolveVaultPrefix('/')).toBe('')
  })

  it('末尾スラッシュが無ければ補完する', () => {
    expect(resolveVaultPrefix('MyVault')).toBe('MyVault/')
  })

  it('末尾スラッシュ付きはそのまま、先頭スラッシュは除去する', () => {
    expect(resolveVaultPrefix('MyVault/')).toBe('MyVault/')
    expect(resolveVaultPrefix('/MyVault')).toBe('MyVault/')
    expect(resolveVaultPrefix('/MyVault/')).toBe('MyVault/')
  })
})

describe('VAULT_PREFIX の末尾スラッシュ有無で同じキーに保存される (#411)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const post = (prefix: string, body: unknown) =>
    app.request(
      'http://example.com/clip',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SHARED_SECRET}`,
        },
        body: JSON.stringify(body),
      },
      { ...env, VAULT_PREFIX: prefix },
      { waitUntil() {} } as unknown as ExecutionContext,
    )

  it('テキストクリップ: MyVault と MyVault/ のどちらも MyVault/Inbox/ 配下', async () => {
    for (const prefix of ['MyVault', 'MyVault/']) {
      const res = await post(prefix, {
        text: `prefix test ${prefix}`,
        title: `prefix-text-${prefix.length}`,
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { path: string }
      expect(json.path.startsWith('MyVault/Inbox/')).toBe(true)
    }
  })

  it('URL クリップ: MyVault と MyVault/ のどちらも MyVault/Inbox/ 配下 + index も同じ', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) =>
        input.toString().startsWith('https://r.jina.ai/')
          ? new Response('Title: T\n\nBody.', { status: 200 })
          : new Response('Not Found', { status: 404 }),
    )
    for (const prefix of ['MyVault', 'MyVault/']) {
      const res = await post(prefix, {
        url: `https://example.com/prefix-url-${prefix.length}`,
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { path: string }
      expect(json.path.startsWith('MyVault/Inbox/')).toBe(true)
    }
    expect(
      await env.VAULT.head('MyVault/Inbox/.index/urls.json'),
    ).not.toBeNull()
    expect(await env.VAULT.head('MyVaultInbox/.index/urls.json')).toBeNull()
  })
})
