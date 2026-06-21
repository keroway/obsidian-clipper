/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * obsidian-clipper tests
 *
 * Unit tests: normalizeUrl, sanitizeForFilename, renderNote
 * Integration test: POST /clip (runs inside Workerd via vitest-pool-workers)
 */

import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from './index'
import {
  fetchArticle,
  hostTagsFor,
  mergeTags,
  normalizeTag,
  normalizeUrl,
  renderNote,
  sanitizeForFilename,
  sha1Hex,
} from './index'

// ─────────────────────────── normalizeUrl ───────────────────────────

describe('normalizeUrl', () => {
  it('strips UTM parameters', () => {
    const input =
      'https://example.com/article?utm_source=twitter&utm_medium=social&utm_campaign=test'
    expect(normalizeUrl(input)).toBe('https://example.com/article')
  })

  it('strips gclid', () => {
    const input = 'https://example.com/page?gclid=abc123&q=hello'
    expect(normalizeUrl(input)).toBe('https://example.com/page?q=hello')
  })

  it('strips fbclid', () => {
    const input = 'https://example.com/?fbclid=XXXXXX'
    expect(normalizeUrl(input)).toBe('https://example.com/')
  })

  it('strips X (Twitter) tracking params s and t', () => {
    const input = 'https://x.com/user/status/123456?s=20&t=abcdefg'
    expect(normalizeUrl(input)).toBe('https://x.com/user/status/123456')
  })

  it('normalizes twitter.com to x.com', () => {
    const input = 'https://twitter.com/user/status/123456'
    expect(normalizeUrl(input)).toBe('https://x.com/user/status/123456')
  })

  it('normalizes mobile.twitter.com to x.com', () => {
    const input = 'https://mobile.twitter.com/user/status/999'
    expect(normalizeUrl(input)).toBe('https://x.com/user/status/999')
  })

  it('preserves non-tracking query params', () => {
    const input = 'https://example.com/search?q=cloudflare+workers&page=2'
    expect(normalizeUrl(input)).toBe(
      'https://example.com/search?q=cloudflare+workers&page=2',
    )
  })

  it('preserves trailing slash', () => {
    const input = 'https://example.com/path/'
    expect(normalizeUrl(input)).toBe('https://example.com/path/')
  })

  it('throws HTTPException on invalid URL', () => {
    expect(() => normalizeUrl('not-a-url')).toThrow()
  })
})

// ─────────────────────────── sanitizeForFilename ───────────────────────────

describe('sanitizeForFilename', () => {
  it('removes backslash', () => {
    expect(sanitizeForFilename('foo\\bar')).toBe('foo bar')
  })

  it('removes forward slash', () => {
    // Each '/' becomes a space; consecutive spaces collapse to one
    expect(sanitizeForFilename('path/to/file')).toBe('path to file')
  })

  it('removes colon', () => {
    // ':' becomes a space; the existing ' ' after ':' collapses with the replacement
    expect(sanitizeForFilename('title: subtitle')).toBe('title subtitle')
  })

  it('removes asterisk', () => {
    expect(sanitizeForFilename('foo*bar')).toBe('foo bar')
  })

  it('removes question mark', () => {
    expect(sanitizeForFilename('what?')).toBe('what')
  })

  it('removes double quote', () => {
    expect(sanitizeForFilename('"quoted"')).toBe('quoted')
  })

  it('removes angle brackets', () => {
    expect(sanitizeForFilename('<tag>')).toBe('tag')
  })

  it('removes pipe character', () => {
    expect(sanitizeForFilename('a|b')).toBe('a b')
  })

  it('removes square brackets', () => {
    expect(sanitizeForFilename('[link]')).toBe('link')
  })

  it('removes hash character', () => {
    expect(sanitizeForFilename('title#section')).toBe('title section')
  })

  it('removes caret', () => {
    expect(sanitizeForFilename('foo^bar')).toBe('foo bar')
  })

  it('removes backtick', () => {
    expect(sanitizeForFilename('`code`')).toBe('code')
  })

  it('collapses multiple spaces', () => {
    expect(sanitizeForFilename('foo   bar')).toBe('foo bar')
  })

  it('trims leading and trailing spaces', () => {
    expect(sanitizeForFilename('  hello  ')).toBe('hello')
  })

  it('trims leading and trailing dots', () => {
    expect(sanitizeForFilename('...foo...')).toBe('foo')
  })

  it('handles normal ASCII title without changes', () => {
    expect(sanitizeForFilename('How to use Cloudflare Workers')).toBe(
      'How to use Cloudflare Workers',
    )
  })
})

// ─────────────────────────── renderNote ───────────────────────────

describe('renderNote', () => {
  const baseOpts = {
    url: 'https://example.com/article',
    title: 'Test Article',
    summary: '',
    body: 'Article body content',
    createdIso: '2026-06-13T12:00:00+09:00',
  }

  it('includes required frontmatter keys: created', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('created: 2026-06-13T12:00:00+09:00')
  })

  it('includes required frontmatter keys: updated', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('updated: 2026-06-13T12:00:00+09:00')
  })

  it('includes required frontmatter keys: source: web-clip', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('source: web-clip')
  })

  it('includes required frontmatter keys: source_url', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('source_url:')
    expect(note).toContain('example.com/article')
  })

  it('includes required frontmatter keys: source_title', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('source_title:')
  })

  it('includes required frontmatter keys: tags', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('tags:')
  })

  it('always includes clipped tag', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('- "clipped"')
  })

  it('includes user-specified tags', () => {
    const note = renderNote({ ...baseOpts, tags: ['tech', 'cloudflare'] })
    expect(note).toContain('"tech"')
    expect(note).toContain('"cloudflare"')
  })

  it('includes summary in frontmatter when provided', () => {
    const note = renderNote({ ...baseOpts, summary: 'A great article.' })
    expect(note).toContain('summary:')
    expect(note).toContain('A great article.')
  })

  it('omits summary field when summary is empty string', () => {
    const note = renderNote(baseOpts)
    expect(note).not.toContain('summary:')
  })

  it('wraps frontmatter in ---', () => {
    const note = renderNote(baseOpts)
    const lines = note.split('\n')
    expect(lines[0]).toBe('---')
    const closingDash = lines.indexOf('---', 1)
    expect(closingDash).toBeGreaterThan(0)
  })

  it('includes article title as H1', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('# Test Article')
  })

  it('includes URL as link', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('<https://example.com/article>')
  })

  it('includes body content', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('Article body content')
  })

  it('includes fetchErr in body section when body is empty', () => {
    const note = renderNote({
      ...baseOpts,
      body: '',
      fetchErr: 'jina 429',
    })
    expect(note).toContain('jina 429')
    expect(note).toContain('## 本文')
  })

  it('includes note/memo section when note is provided', () => {
    const note = renderNote({ ...baseOpts, note: 'My note here' })
    expect(note).toContain('[!note]')
    expect(note).toContain('My note here')
  })

  it('includes selection/excerpt section when selection is provided', () => {
    const note = renderNote({ ...baseOpts, selection: 'Selected text' })
    expect(note).toContain('## 抜粋')
    expect(note).toContain('Selected text')
  })
})

// ─────────────────────────── sha1Hex ───────────────────────────

describe('sha1Hex', () => {
  it('returns 40-char lowercase hex string', async () => {
    const h = await sha1Hex('https://example.com/')
    expect(h).toHaveLength(40)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic for the same input', async () => {
    const h1 = await sha1Hex('https://example.com/article')
    const h2 = await sha1Hex('https://example.com/article')
    expect(h1).toBe(h2)
  })

  it('differs for different inputs', async () => {
    const h1 = await sha1Hex('https://example.com/a')
    const h2 = await sha1Hex('https://example.com/b')
    expect(h1).not.toBe(h2)
  })
})

// ─────────────────────────── tags ───────────────────────────

describe('normalizeTag', () => {
  it('lowercases', () => {
    expect(normalizeTag('Cloudflare')).toBe('cloudflare')
  })

  it('converts spaces to hyphens', () => {
    expect(normalizeTag('machine learning')).toBe('machine-learning')
  })

  it('collapses repeated hyphens', () => {
    expect(normalizeTag('a  -  b')).toBe('a-b')
  })

  it('strips disallowed symbols', () => {
    expect(normalizeTag('c++/rust!')).toBe('crust')
  })

  it('trims leading/trailing hyphens and underscores', () => {
    expect(normalizeTag('--foo_')).toBe('foo')
  })

  it('keeps Japanese characters', () => {
    expect(normalizeTag('技術')).toBe('技術')
  })

  it('returns empty string for symbol-only input', () => {
    expect(normalizeTag('***')).toBe('')
  })
})

describe('mergeTags', () => {
  it('normalizes, dedupes and preserves order', () => {
    expect(mergeTags(['clipped', 'Tech', 'tech', 'AI'])).toEqual([
      'clipped',
      'tech',
      'ai',
    ])
  })

  it('drops empty-after-normalize entries', () => {
    expect(mergeTags(['clipped', '***', 'ok'])).toEqual(['clipped', 'ok'])
  })

  it('caps total tags at the limit (8)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`)
    expect(mergeTags(many)).toHaveLength(8)
  })
})

describe('hostTagsFor', () => {
  it('matches exact host', () => {
    expect(hostTagsFor('https://zenn.dev/foo/articles/bar')).toEqual(['zenn'])
  })

  it('matches subdomain via suffix', () => {
    expect(hostTagsFor('https://blog.hatenablog.com/entry/1')).toEqual([
      'hatena',
    ])
  })

  it('normalizes twitter→x is out of scope here; matches x.com', () => {
    expect(hostTagsFor('https://x.com/user/status/1')).toEqual(['x'])
  })

  it('returns empty for unknown hosts', () => {
    expect(hostTagsFor('https://example.com/a')).toEqual([])
  })
})

// ─────────────────────────── fetchArticle (retry + fallback) ───────────────────────────

describe('fetchArticle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // Browser Rendering を無効にした最小 env (Jina のみ)
  const jinaOnlyEnv = {} as Bindings
  // Browser Rendering を有効にした env
  const brEnv = {
    CF_ACCOUNT_ID: 'acc-123',
    BROWSER_RENDERING_API_TOKEN: 'br-token',
  } as Bindings

  it('returns md and via=jina on first-try 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('Title: Hello\n\nBody.', { status: 200 })
      }
      return new Response('nope', { status: 404 })
    })

    const r = await fetchArticle('https://example.com/a', jinaOnlyEnv)
    expect(r.md).toContain('Body.')
    expect(r.title).toBe('Hello')
    expect(r.via).toBe('jina')
    expect(r.err).toBeUndefined()
  })

  it('retries on 429 then succeeds (via=jina-retry)', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        calls++
        if (calls === 1) return new Response('rate', { status: 429 })
        return new Response('Title: Retried\n\nOK.', { status: 200 })
      }
      return new Response('nope', { status: 404 })
    })

    const r = await fetchArticle('https://example.com/b', jinaOnlyEnv)
    expect(calls).toBe(2)
    expect(r.md).toContain('OK.')
    expect(r.via).toBe('jina-retry')
  })

  it('falls back to browser-rendering after jina keeps failing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('rate', { status: 429 })
      }
      if (u.includes('/browser-rendering/markdown')) {
        return new Response(
          JSON.stringify({ success: true, result: 'Title: BR\n\nFrom BR.' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('nope', { status: 404 })
    })

    const r = await fetchArticle('https://example.com/c', brEnv)
    expect(r.md).toContain('From BR.')
    expect(r.via).toBe('browser-rendering')
    expect(r.err).toBeUndefined()
  })

  it('returns empty md + err when every path fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('rate', { status: 429 })
      }
      if (u.includes('/browser-rendering/markdown')) {
        return new Response('boom', { status: 500 })
      }
      return new Response('nope', { status: 404 })
    })

    const r = await fetchArticle('https://example.com/d', brEnv)
    expect(r.md).toBe('')
    expect(r.via).toBeUndefined()
    expect(r.err).toBeTruthy()
  })

  it('does not retry on non-retryable status (404)', async () => {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        calls++
        return new Response('gone', { status: 404 })
      }
      return new Response('nope', { status: 404 })
    })

    const r = await fetchArticle('https://example.com/e', jinaOnlyEnv)
    expect(calls).toBe(1)
    expect(r.md).toBe('')
    expect(r.err).toContain('404')
  })
})

// ─────────────────────────── Integration: POST /clip ───────────────────────────

describe('POST /clip integration', () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    vi.restoreAllMocks()
  })

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/article' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when wrong Bearer token is provided', async () => {
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-secret',
      },
      body: JSON.stringify({ url: 'https://example.com/article' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when url is missing', async () => {
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify({ title: 'No URL here' }),
    })
    expect(res.status).toBe(400)
  })

  it('saves clip to R2 and returns ok: true', async () => {
    // Mock the outbound Jina fetch so the test is self-contained
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString()
        if (url.startsWith('https://r.jina.ai/')) {
          return new Response(
            'Title: Example Article\n\nThis is the article body.',
            { status: 200 },
          )
        }
        // Pass through unexpected calls
        return new Response('Not Found', { status: 404 })
      },
    )

    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify({
        url: 'https://example.com/article?utm_source=test',
        tags: ['test'],
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      path: string
      bytes: number
    }
    expect(json.ok).toBe(true)
    // Path should be under Inbox/ with a .md extension
    expect(json.path).toMatch(/Inbox\/.*\.md$/)
    // Verify R2 PUT actually happened by retrieving the object
    const stored = await env.VAULT.get(json.path)
    expect(stored).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: expect() assertion above guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('source: web-clip')
    expect(content).toContain('source_url:')
    // UTM param should be stripped
    expect(content).not.toContain('utm_source')
  })
})

// ─────────────────────────── Integration: duplicate detection ───────────────────────────

describe('POST /clip - duplicate detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const mockJina = () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString()
        if (url.startsWith('https://r.jina.ai/')) {
          return new Response('Title: Test Article\n\nBody content.', {
            status: 200,
          })
        }
        return new Response('Not Found', { status: 404 })
      },
    )
  }

  const clipUrl = async (url: string, query = '') => {
    return SELF.fetch(`http://example.com/clip${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify({ url }),
    })
  }

  it('returns duplicate:true on second clip of the same URL', async () => {
    mockJina()
    const url = 'https://example.com/dedup-test-unique-1'

    const res1 = await clipUrl(url)
    expect(res1.status).toBe(200)
    const json1 = (await res1.json()) as { ok: boolean; path: string }
    expect(json1.ok).toBe(true)

    const res2 = await clipUrl(url)
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as {
      ok: boolean
      duplicate: boolean
      path: string
    }
    expect(json2.ok).toBe(false)
    expect(json2.duplicate).toBe(true)
    expect(json2.path).toBe(json1.path)
  })

  it('saves successfully with ?refresh=1 even if duplicate', async () => {
    mockJina()
    const url = 'https://example.com/dedup-refresh-unique-1'

    const res1 = await clipUrl(url)
    expect(((await res1.json()) as { ok: boolean }).ok).toBe(true)

    const res2 = await clipUrl(url, '?refresh=1')
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as { ok: boolean }
    expect(json2.ok).toBe(true)
  })

  it('updates index path after refresh, so next clip reports duplicate with new path', async () => {
    mockJina()
    const url = 'https://example.com/dedup-refresh-index-unique-1'

    // Initial clip
    await clipUrl(url)

    // Refresh — saves a new file and updates the index
    const res2 = await clipUrl(url, '?refresh=1')
    const json2 = (await res2.json()) as { ok: boolean; path: string }
    expect(json2.ok).toBe(true)

    // Next duplicate should point to the refreshed path
    const res3 = await clipUrl(url)
    const json3 = (await res3.json()) as {
      ok: boolean
      duplicate: boolean
      path: string
    }
    expect(json3.ok).toBe(false)
    expect(json3.duplicate).toBe(true)
    expect(json3.path).toBe(json2.path)
  })
})

// ─────────── Integration: fetch-failure invariant (200 + URL/memo saved) ───────────

describe('POST /clip - fetch failure invariant', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('still returns 200 and saves URL + note when fetch fails entirely', async () => {
    // Jina always 429; Browser Rendering not configured in test env → no fallback
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('rate', { status: 429 })
      }
      return new Response('nope', { status: 404 })
    })

    const url = 'https://example.com/fetch-fail-invariant-unique-1'
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify({ url, note: 'keep me' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; path: string }
    expect(json.ok).toBe(true)

    const stored = await env.VAULT.get(json.path)
    expect(stored).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees non-null
    const content = await stored!.text()
    // URL is preserved
    expect(content).toContain(url)
    // user note is preserved
    expect(content).toContain('keep me')
    // fetch error is recorded in body section
    expect(content).toContain('jina 429')
  })
})

// ─────────── Integration: auto-tagging (allowlist, ENABLE_AUTO_TAG off in test env) ───────────

describe('POST /clip - auto tagging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const clip = async (url: string, tags?: string[]) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('Title: T\n\nBody content here.', { status: 200 })
      }
      return new Response('nope', { status: 404 })
    })
    return SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify(tags ? { url, tags } : { url }),
    })
  }

  it('adds allowlist host tag and keeps clipped + user tags', async () => {
    // ENABLE_AUTO_TAG is unset in test env → no LLM call, allowlist still applies
    const res = await clip('https://zenn.dev/foo/articles/tag-test-1', ['mine'])
    const json = (await res.json()) as { ok: boolean; path: string }
    expect(json.ok).toBe(true)
    const stored = await env.VAULT.get(json.path)
    // biome-ignore lint/style/noNonNullAssertion: assertion guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('- "clipped"')
    expect(content).toContain('- "mine"')
    expect(content).toContain('- "zenn"')
  })

  it('only clipped tag for unknown host without user tags', async () => {
    const res = await clip('https://unknown-host-xyz.example/a/tag-test-2')
    const json = (await res.json()) as { ok: boolean; path: string }
    const stored = await env.VAULT.get(json.path)
    // biome-ignore lint/style/noNonNullAssertion: assertion guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('- "clipped"')
    // frontmatter tags block should only contain clipped (no host/user tags)
    const fmTags = content.slice(
      content.indexOf('tags:'),
      content.indexOf('summary:') > -1
        ? content.indexOf('summary:')
        : content.indexOf('---', 4),
    )
    expect(fmTags).not.toContain('- "zenn"')
  })
})
