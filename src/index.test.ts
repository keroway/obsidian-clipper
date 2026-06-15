/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * obsidian-clipper tests
 *
 * Unit tests: normalizeUrl, sanitizeForFilename, renderNote
 * Integration test: POST /clip (runs inside Workerd via vitest-pool-workers)
 */

import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeUrl, renderNote, sanitizeForFilename } from './index'

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
