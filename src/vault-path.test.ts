import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { resolveFolder, resolveVaultPrefix } from './vault-path'

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

describe('resolveFolder (#415)', () => {
  it('前後スラッシュを除去する', () => {
    expect(resolveFolder('/Inbox/', 'X')).toBe('Inbox')
    expect(resolveFolder('A/B', 'X')).toBe('A/B')
  })

  it('空 / 未設定 / スラッシュのみは既定値へ復帰する', () => {
    expect(resolveFolder(undefined, 'Inbox')).toBe('Inbox')
    expect(resolveFolder('', 'Inbox')).toBe('Inbox')
    expect(resolveFolder('///', 'Inbox')).toBe('Inbox')
  })
})

describe('INBOX_FOLDER がスラッシュのみでも不正キーにならない (#415)', () => {
  it('テキストクリップ: /// でも Inbox/ 配下に保存される', async () => {
    const res = await app.request(
      'http://example.com/clip',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SHARED_SECRET}`,
        },
        body: JSON.stringify({
          text: 'slash only folder',
          title: 'slash-only',
        }),
      },
      { ...env, INBOX_FOLDER: '///', VAULT_PREFIX: 'MyVault/' },
      { waitUntil() {} } as unknown as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { path: string }
    expect(json.path.startsWith('MyVault/Inbox/')).toBe(true)
    expect(json.path).not.toContain('//')
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
