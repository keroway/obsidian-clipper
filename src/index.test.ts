/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * obsidian-clipper tests
 *
 * Unit tests: normalizeUrl, sanitizeForFilename, renderNote
 * Integration test: POST /clip (runs inside Workerd via vitest-pool-workers)
 */

import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_IMAGE_BYTES,
  extForMime,
  resolveMaxImageBytes,
} from './attachment'
import type { Bindings } from './bindings'
import { classifyJsonBody, detectContentKind } from './clip-input'
import { fetchArticle } from './fetch-article'
import { generateTags, summarizeWithProvider } from './llm'
import { renderNote, sanitizeForFilename } from './note'
import { notifyWebhook } from './notify'
import {
  autoTagsEnabled,
  hostTagsFor,
  mergeTags,
  normalizeTag,
  resolveHostTagRules,
} from './tags'
import { normalizeUrl } from './url'
import {
  readUrlIndex,
  sha1Hex,
  sha1HexBytes,
  writeUrlIndexCAS,
} from './url-index'

// ─────────────────────────── normalizeUrl ───────────────────────────

describe('normalizeUrl', () => {
  // ─── ホスト限定のトラッキング除去（#73）───
  //
  // `s` / `t` / `si` は X や YouTube では共有用トラッキングだが、一般的な
  // クエリ名でもある。ホストを見ずに削ると別サイトの意味あるパラメータを壊す。

  it('WordPress の検索クエリ ?s= を残す', () => {
    // 以前はここが `https://blog.example.com/` に化けて、検索結果ページが
    // トップページとしてクリップされていた。
    expect(normalizeUrl('https://blog.example.com/?s=gleam')).toBe(
      'https://blog.example.com/?s=gleam',
    )
  })

  it('YouTube の再生開始位置 ?t= を残しつつ si は削る', () => {
    expect(
      normalizeUrl('https://www.youtube.com/watch?v=abc&t=120&si=xyz'),
    ).toBe('https://www.youtube.com/watch?v=abc&t=120')
  })

  it('X の共有パラメータ s / t は削る', () => {
    expect(normalizeUrl('https://x.com/user/status/1?s=20&t=abc')).toBe(
      'https://x.com/user/status/1',
    )
  })

  it('twitter.com は x.com へ正規化したうえで s / t を削る', () => {
    expect(normalizeUrl('https://twitter.com/u/status/1?s=20')).toBe(
      'https://x.com/u/status/1',
    )
  })

  it('サブドメインにも適用する（m.youtube.com）', () => {
    expect(normalizeUrl('https://m.youtube.com/watch?v=abc&si=xyz')).toBe(
      'https://m.youtube.com/watch?v=abc',
    )
  })

  it('ホスト名の部分一致で誤爆しない（evil-x.com）', () => {
    // ドット境界で判定しないと `evil-x.com` が `x.com` に一致してしまう。
    expect(normalizeUrl('https://evil-x.com/?s=keep')).toBe(
      'https://evil-x.com/?s=keep',
    )
  })

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
    tags: ['clipped'],
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
    const note = renderNote({
      ...baseOpts,
      tags: ['clipped', 'tech', 'cloudflare'],
    })
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

  // ADR 0011: source / url の後方互換拡張
  it('defaults to source: web-clip when source is not specified (regression)', () => {
    const note = renderNote(baseOpts)
    expect(note).toContain('source: web-clip')
  })

  it('uses the given source value instead of web-clip', () => {
    const note = renderNote({ ...baseOpts, source: 'text-clip' })
    expect(note).toContain('source: text-clip')
    expect(note).not.toContain('source: web-clip')
  })

  it('omits source_url and <url> when url is not provided', () => {
    const note = renderNote({
      source: 'text-clip',
      title: 'A note',
      body: 'body text',
      createdIso: '2026-06-13T12:00:00+09:00',
      tags: ['clipped'],
    })
    expect(note).not.toContain('source_url:')
    expect(note).not.toContain('<undefined>')
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

describe('sha1HexBytes', () => {
  it('returns 40-char lowercase hex string', async () => {
    const h = await sha1HexBytes(new TextEncoder().encode('hello'))
    expect(h).toHaveLength(40)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic for the same bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const h1 = await sha1HexBytes(bytes)
    const h2 = await sha1HexBytes(bytes)
    expect(h1).toBe(h2)
  })

  it('differs for different bytes', async () => {
    const h1 = await sha1HexBytes(new Uint8Array([1, 2, 3]))
    const h2 = await sha1HexBytes(new Uint8Array([4, 5, 6]))
    expect(h1).not.toBe(h2)
  })

  it('agrees with sha1Hex for the equivalent text', async () => {
    const h1 = await sha1Hex('agreement-check')
    const h2 = await sha1HexBytes(new TextEncoder().encode('agreement-check'))
    expect(h1).toBe(h2)
  })
})

// ─────────────────────────── clip-input ───────────────────────────

describe('detectContentKind', () => {
  it('detects multipart/form-data (with boundary param)', () => {
    expect(
      detectContentKind('multipart/form-data; boundary=----WebKitFormBoundary'),
    ).toBe('multipart')
  })

  it('treats application/json as json', () => {
    expect(detectContentKind('application/json')).toBe('json')
  })

  it('treats missing content-type as json', () => {
    expect(detectContentKind(undefined)).toBe('json')
  })
})

describe('classifyJsonBody', () => {
  it('classifies as url when url is a non-empty string', () => {
    const result = classifyJsonBody({ url: 'https://example.com/a' })
    expect(result?.kind).toBe('url')
  })

  // ─── 実行時の型検証（#75）───
  //
  // 以前は `as unknown as UrlClipBody` で素通しており、型注釈は付いているのに
  // 実際の値が違うという状態を作っていた。下流が `.trim()` や spread で壊れる。

  it('文字列の tags を配列として受け取らない（1 文字ずつのタグ化を防ぐ）', () => {
    // 以前はここが素通りし、`mergeTags(['clipped', ...'test'])` が
    // `clipped, t, e, s, t` を frontmatter に書き込んでいた。
    const result = classifyJsonBody({
      url: 'https://example.com/a',
      tags: 'test',
    })

    expect(result?.body.tags).toEqual([])
    expect(result?.droppedTags).toBe(true)
  })

  it('配列の中の非文字列要素だけを捨てる', () => {
    const result = classifyJsonBody({
      url: 'https://example.com/a',
      tags: ['ok', 42, null, 'fine'],
    })

    expect(result?.body.tags).toEqual(['ok', 'fine'])
    expect(result?.droppedTags).toBe(true)
  })

  it('正しい tags は droppedTags を立てない', () => {
    const result = classifyJsonBody({
      url: 'https://example.com/a',
      tags: ['a', 'b'],
    })

    expect(result?.body.tags).toEqual(['a', 'b'])
    expect(result?.droppedTags).toBe(false)
  })

  it('文字列でない title / note / selection を undefined にする', () => {
    // 以前は素通りし、`payload.title?.trim()` が実行時に落ちて 500 になっていた。
    const result = classifyJsonBody({
      url: 'https://example.com/a',
      title: 123,
      note: ['x'],
      selection: { a: 1 },
    })

    expect(result?.body.title).toBeUndefined()
    expect(result?.kind === 'url' && result.body.selection).toBeUndefined()
    expect(result?.body.note).toBeUndefined()
  })

  it('text クリップでも同じ検証が効く', () => {
    const result = classifyJsonBody({
      markdown: '# hi',
      tags: 'oops',
      title: 7,
    })

    expect(result?.kind).toBe('text')
    expect(result?.body.tags).toEqual([])
    expect(result?.body.title).toBeUndefined()
    expect(result?.droppedTags).toBe(true)
  })

  it('classifies as text when markdown is provided without url', () => {
    const result = classifyJsonBody({ markdown: '# hi' })
    expect(result?.kind).toBe('text')
  })

  it('classifies as text when text is provided without url', () => {
    const result = classifyJsonBody({ text: 'plain note' })
    expect(result?.kind).toBe('text')
  })

  it('prefers url over markdown/text when both are present', () => {
    const result = classifyJsonBody({
      url: 'https://example.com/a',
      markdown: '# hi',
    })
    expect(result?.kind).toBe('url')
  })

  it('returns null when neither url nor markdown/text is present', () => {
    expect(classifyJsonBody({ title: 'no content' })).toBeNull()
  })

  it('returns null for non-object bodies', () => {
    expect(classifyJsonBody(null)).toBeNull()
    expect(classifyJsonBody('string')).toBeNull()
  })
})

// ─────────────────────────── attachment ───────────────────────────

describe('extForMime', () => {
  it('maps known image MIME types to extensions', () => {
    expect(extForMime('image/png')).toBe('png')
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('image/gif')).toBe('gif')
    expect(extForMime('image/webp')).toBe('webp')
  })

  it('falls back to filename extension when MIME is empty', () => {
    expect(extForMime('', 'photo.png')).toBe('png')
  })

  it('returns null for unsupported MIME and no usable filename', () => {
    expect(extForMime('application/pdf')).toBeNull()
  })

  it('returns null for svg (excluded in v1)', () => {
    expect(extForMime('image/svg+xml')).toBeNull()
  })
})

describe('writeUrlIndexCAS', () => {
  const indexKey = 'test-cas-index.json'

  it('writes a new index when none exists', async () => {
    const written = await writeUrlIndexCAS(env.VAULT, indexKey, (index) => {
      index.abc = { path: 'Inbox/a.md', createdAt: '2026-01-01T00:00:00+09:00' }
    })
    expect(written).toBe(true)
    const { index } = await readUrlIndex(env.VAULT, indexKey)
    expect(index.abc.path).toBe('Inbox/a.md')
  })

  it('merges into an existing index without losing prior entries', async () => {
    await writeUrlIndexCAS(env.VAULT, indexKey, (index) => {
      index.one = {
        path: 'Inbox/one.md',
        createdAt: '2026-01-01T00:00:00+09:00',
      }
    })
    await writeUrlIndexCAS(env.VAULT, indexKey, (index) => {
      index.two = {
        path: 'Inbox/two.md',
        createdAt: '2026-01-02T00:00:00+09:00',
      }
    })
    const { index } = await readUrlIndex(env.VAULT, indexKey)
    expect(index.one.path).toBe('Inbox/one.md')
    expect(index.two.path).toBe('Inbox/two.md')
  })

  it('does not lose an entry written concurrently between calls', async () => {
    await writeUrlIndexCAS(env.VAULT, indexKey, (index) => {
      index.base = {
        path: 'Inbox/base.md',
        createdAt: '2026-01-01T00:00:00+09:00',
      }
    })

    // Simulate a concurrent writer committing directly (bypassing CAS) after we
    // would have read the index but before our own write lands.
    await env.VAULT.put(
      indexKey,
      JSON.stringify({
        base: { path: 'Inbox/base.md', createdAt: '2026-01-01T00:00:00+09:00' },
        concurrent: {
          path: 'Inbox/concurrent.md',
          createdAt: '2026-01-03T00:00:00+09:00',
        },
      }),
    )

    // writeUrlIndexCAS reads fresh on each call, so it must pick up the
    // concurrently-written entry rather than clobbering it.
    await writeUrlIndexCAS(env.VAULT, indexKey, (index) => {
      index.mine = {
        path: 'Inbox/mine.md',
        createdAt: '2026-01-04T00:00:00+09:00',
      }
    })

    const { index } = await readUrlIndex(env.VAULT, indexKey)
    expect(index.base.path).toBe('Inbox/base.md')
    expect(index.concurrent.path).toBe('Inbox/concurrent.md')
    expect(index.mine.path).toBe('Inbox/mine.md')
  })

  it('does not overwrite a corrupted index with an empty one (#92) and reports the skip (#101)', async () => {
    const corruptKey = 'test-cas-index-corrupt.json'
    await env.VAULT.put(corruptKey, '{ this is not valid json')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const written = await writeUrlIndexCAS(env.VAULT, corruptKey, (index) => {
      index.new = {
        path: 'Inbox/new.md',
        createdAt: '2026-01-01T00:00:00+09:00',
      }
    })

    expect(written).toBe(false)
    const stored = await env.VAULT.get(corruptKey)
    expect(await stored?.text()).toBe('{ this is not valid json')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('readUrlIndex', () => {
  it('returns corrupted: true and warns when the stored JSON is invalid', async () => {
    const corruptKey = 'test-read-index-corrupt.json'
    await env.VAULT.put(corruptKey, '{ this is not valid json')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { index, corrupted } = await readUrlIndex(env.VAULT, corruptKey)

    expect(corrupted).toBe(true)
    expect(index).toEqual({})
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
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

  it('applies AUTO_TAGS_ALLOWLIST env rules (host:tag,...)', () => {
    const env = {
      AUTO_TAGS_ALLOWLIST: 'example.com:demo,foo.test:bar',
    } as unknown as Bindings
    expect(hostTagsFor('https://example.com/a', env)).toEqual(['demo'])
    expect(hostTagsFor('https://sub.foo.test/a', env)).toEqual(['bar'])
  })

  it('merges env allowlist on top of defaults', () => {
    const env = {
      AUTO_TAGS_ALLOWLIST: 'example.com:demo',
    } as unknown as Bindings
    // default rule still applies
    expect(hostTagsFor('https://zenn.dev/x', env)).toEqual(['zenn'])
    // env rule applies too
    expect(hostTagsFor('https://example.com/x', env)).toEqual(['demo'])
  })
})

describe('resolveHostTagRules', () => {
  it('returns defaults when allowlist is undefined', () => {
    const rules = resolveHostTagRules(undefined)
    expect(rules.some(([h, t]) => h === 'zenn.dev' && t === 'zenn')).toBe(true)
  })

  it('parses host:tag pairs and normalizes the tag', () => {
    const rules = resolveHostTagRules('Example.COM: Demo Tag ')
    expect(rules).toContainEqual(['example.com', 'demo-tag'])
  })

  it('ignores malformed entries (missing colon / empty parts)', () => {
    const before = resolveHostTagRules(undefined).length
    const rules = resolveHostTagRules('nocolon,:notag,host.com:,,good.com:ok')
    expect(rules).toContainEqual(['good.com', 'ok'])
    // only the one valid entry is appended
    expect(rules.length).toBe(before + 1)
  })

  it('dedupes entries already present in defaults', () => {
    const before = resolveHostTagRules(undefined).length
    const rules = resolveHostTagRules('zenn.dev:zenn')
    expect(rules.length).toBe(before)
  })
})

describe('autoTagsEnabled', () => {
  it('true when ENABLE_AUTO_TAGS is "true"', () => {
    expect(autoTagsEnabled({ ENABLE_AUTO_TAGS: 'true' } as Bindings)).toBe(true)
  })

  it('true when legacy ENABLE_AUTO_TAG is "true" (back-compat)', () => {
    expect(autoTagsEnabled({ ENABLE_AUTO_TAG: 'true' } as Bindings)).toBe(true)
  })

  it('false when neither is set', () => {
    expect(autoTagsEnabled({} as Bindings)).toBe(false)
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

// ─────────────────── summarizeWithProvider / generateTags ───────────────────

describe('summarizeWithProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // AI.run を spy にして**呼び出し回数**まで見る。結果値だけを検証すると、
  // anthropic 経路のつもりが workers-ai にフォールバックしていても気づけない
  // （どちらも同じ文字列を返しうる）。
  const workersAiEnv = (response: string) => {
    const run = vi.fn(async () => ({ response }))
    return {
      env: {
        SUMMARY_MODEL: '@cf/meta/llama-3.1-8b-instruct',
        AI: { run },
      } as unknown as Bindings,
      run,
    }
  }

  it('uses workers-ai when SUMMARY_PROVIDER is unset', async () => {
    const { env: testEnv, run } = workersAiEnv('workers-ai summary')
    const result = await summarizeWithProvider(testEnv, 'body text', 'Title')

    expect(result).toBe('workers-ai summary')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses anthropic when SUMMARY_PROVIDER=anthropic and key is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input.toString() === 'https://api.anthropic.com/v1/messages') {
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'anthropic summary' }],
          }),
          { status: 200 },
        )
      }
      return new Response('nope', { status: 404 })
    })

    const { env, run } = workersAiEnv('should not be used')
    const testEnv = {
      ...env,
      SUMMARY_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
    } as Bindings
    const result = await summarizeWithProvider(testEnv, 'body text', 'Title')

    expect(result).toBe('anthropic summary')
    // anthropic が成功したので workers-ai へは落ちていない。
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back to workers-ai once when anthropic fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('server error', { status: 500 })
    })

    const { env, run } = workersAiEnv('fallback summary')
    const testEnv = {
      ...env,
      SUMMARY_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
    } as Bindings
    const result = await summarizeWithProvider(testEnv, 'body text', 'Title')

    expect(result).toBe('fallback summary')
    // anthropic が失敗したぶんを workers-ai が 1 回だけ肩代わりする。
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('generateTags', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // AI.run を spy にして**呼び出し回数**まで見る。結果値だけを検証すると、
  // anthropic 経路のつもりが workers-ai にフォールバックしていても気づけない
  // （どちらも同じ文字列を返しうる）。
  const workersAiEnv = (response: string) => {
    const run = vi.fn(async () => ({ response }))
    return {
      env: {
        SUMMARY_MODEL: '@cf/meta/llama-3.1-8b-instruct',
        AI: { run },
      } as unknown as Bindings,
      run,
    }
  }

  it('uses workers-ai when SUMMARY_PROVIDER is unset', async () => {
    const { env: testEnv, run } = workersAiEnv('tag1, tag2')
    const tags = await generateTags(testEnv, 'body text', 'Title')

    expect(tags).toEqual(['tag1', 'tag2'])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses anthropic when SUMMARY_PROVIDER=anthropic and key is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input.toString() === 'https://api.anthropic.com/v1/messages') {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'tagA, tagB' }] }),
          { status: 200 },
        )
      }
      return new Response('nope', { status: 404 })
    })

    const { env, run } = workersAiEnv('should not be used')
    const testEnv = {
      ...env,
      SUMMARY_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
    } as Bindings
    const tags = await generateTags(testEnv, 'body text', 'Title')

    expect(tags).toEqual(['tagA', 'tagB'])
    // anthropic が成功したので workers-ai へは落ちていない。
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back to workers-ai when anthropic fails (does not throw)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('server error', { status: 500 })
    })

    const { env, run } = workersAiEnv('fallbackTag')
    const testEnv = {
      ...env,
      SUMMARY_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test',
    } as Bindings
    const tags = await generateTags(testEnv, 'body text', 'Title')

    expect(tags).toEqual(['fallbackTag'])
    // anthropic が失敗したぶんを workers-ai が 1 回だけ肩代わりする。
    expect(run).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────── notifyWebhook ───────────────────────────

describe('notifyWebhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ─── HTTP ステータスの検証（#72）───
  //
  // 以前は fetch の例外だけを catch しており、webhook 側が 401/404/500 を
  // 返しても成功として素通りしていた。「本文取得失敗」等の通知が届いていない
  // ことに誰も気づけない — **通知の仕組み自体が silent fallback** だった。

  it('非 2xx を受けたら警告を出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('bad token', { status: 401 }),
    )

    await notifyWebhook('https://webhook.test/x', 'msg')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('401')
  })

  it('警告にレスポンス本文を含める（理由がステータスだけでは分からないため）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('channel not found', { status: 404 }),
    )

    await notifyWebhook('https://webhook.test/x', 'msg')

    expect(String(warn.mock.calls[0]?.[0])).toContain('channel not found')
  })

  it('本文が長いときは切り詰める（HTML が返ることがある）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('x'.repeat(500), { status: 500 }),
    )

    await notifyWebhook('https://webhook.test/x', 'msg')

    const logged = String(warn.mock.calls[0]?.[0])
    expect(logged.length).toBeLessThan(300)
    expect(logged).toContain('…')
  })

  it('2xx なら警告を出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('ok', { status: 200 }),
    )

    await notifyWebhook('https://webhook.test/x', 'msg')

    expect(warn).not.toHaveBeenCalled()
  })

  it('POSTs the message as text/content JSON to the webhook url', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      capturedUrl = input.toString()
      capturedBody = String((init as RequestInit | undefined)?.body ?? '')
      return new Response('ok', { status: 200 })
    })

    await notifyWebhook('https://webhook.test/notify', 'hello world')

    expect(capturedUrl).toBe('https://webhook.test/notify')
    expect(JSON.parse(capturedBody)).toEqual({
      text: 'hello world',
      content: 'hello world',
    })
  })

  it('swallows fetch errors without rejecting the caller', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down')
    })

    await expect(
      notifyWebhook('https://webhook.test/notify', 'hello'),
    ).resolves.toBeUndefined()
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

  it('does not overwrite an existing note when title extraction fails for two different URLs on the same host (#103)', async () => {
    // No "Title:" line in the Jina response, so articleTitle stays undefined
    // and the filename slug falls back to hostname(url) — identical for both
    // URLs below, which used to make the filename collide within the same
    // second and silently overwrite the first note.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString()
        if (url.startsWith('https://r.jina.ai/')) {
          return new Response('First article body.', { status: 200 })
        }
        return new Response('Not Found', { status: 404 })
      },
    )

    const clip = async (url: string) =>
      SELF.fetch('http://example.com/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SHARED_SECRET}`,
        },
        body: JSON.stringify({ url }),
      })

    const res1 = await clip('https://example.com/collision-article-one')
    expect(res1.status).toBe(200)
    const json1 = (await res1.json()) as { ok: boolean; path: string }
    expect(json1.ok).toBe(true)

    const res2 = await clip('https://example.com/collision-article-two')
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as { ok: boolean; path: string }
    expect(json2.ok).toBe(true)

    // Different filenames despite identical slug/hostname fallback.
    expect(json2.path).not.toBe(json1.path)

    // Both notes still exist independently — the second clip must not have
    // overwritten the first.
    const stored1 = await env.VAULT.get(json1.path)
    const stored2 = await env.VAULT.get(json2.path)
    expect(stored1).not.toBeNull()
    expect(stored2).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: expect() assertions above guarantee non-null
    const content1 = await stored1!.text()
    // biome-ignore lint/style/noNonNullAssertion: expect() assertions above guarantee non-null
    const content2 = await stored2!.text()
    expect(content1).toContain('collision-article-one')
    expect(content2).toContain('collision-article-two')
  })

  it('returns bytes as actual UTF-8 byte length (not UTF-16 code unit count)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = input.toString()
        if (url.startsWith('https://r.jina.ai/')) {
          return new Response('Title: 日本語記事\n\nこれは日本語の本文です。', {
            status: 200,
          })
        }
        return new Response('Not Found', { status: 404 })
      },
    )

    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify({ url: 'https://example.com/ja-article' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      path: string
      bytes: number
    }
    expect(json.ok).toBe(true)
    const stored = await env.VAULT.get(json.path)
    expect(stored).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: expect() assertion above guarantees non-null
    const content = await stored!.text()
    const utf16Length = content.length
    const utf8Length = new TextEncoder().encode(content).length
    // Japanese text: UTF-8 byte length must exceed UTF-16 code unit count,
    // and the response must report the UTF-8 byte length.
    expect(utf8Length).toBeGreaterThan(utf16Length)
    expect(json.bytes).toBe(utf8Length)
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

  it('allows re-clipping when the indexed file no longer exists in R2 (ADR 0010)', async () => {
    mockJina()
    const url = 'https://example.com/dedup-deleted-file-unique-1'

    const res1 = await clipUrl(url)
    expect(res1.status).toBe(200)
    const json1 = (await res1.json()) as { ok: boolean; path: string }
    expect(json1.ok).toBe(true)

    // Simulate the user moving/deleting the clipped file from Obsidian.
    await env.VAULT.delete(json1.path)

    // Re-clipping the same URL should NOT be treated as a duplicate anymore,
    // since the indexed file no longer exists.
    const res2 = await clipUrl(url)
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as {
      ok: boolean
      duplicate?: boolean
      path: string
    }
    expect(json2.ok).toBe(true)
    expect(json2.duplicate).toBeUndefined()

    // The new file should actually exist in R2.
    const stored = await env.VAULT.get(json2.path)
    expect(stored).not.toBeNull()
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

// ─────────── Integration: auto-tagging (allowlist, ENABLE_AUTO_TAGS off in test env) ───────────

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
    // ENABLE_AUTO_TAGS is unset in test env → no LLM call, allowlist still applies
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

  /// タグ生成が失敗したとき、要約・本文取得と同じく webhook へ通知すること（#70）。
  ///
  /// ADR 0006 は「失敗を無音にしない」としており本文取得・要約は通知していたが、
  /// 後発の ADR 0008 で足したタグ生成パスだけ `console.warn` 止まりだった。
  /// LLM 障害でタグが付かなくなっても、ログを能動的に見ない限り気づけない。
  ///
  /// テスト env には `NOTIFY_WEBHOOK_URL` / `ENABLE_AUTO_TAGS` が無いので、
  /// **この 2 つをその場で注入する**。注入しないとタグ生成自体が走らず、
  /// 「通知が来ない」を合格と読み違える（実際、最初はそうなっていて
  /// 通知処理を消す変異が素通りした）。
  it('notifies the webhook when auto-tagging fails', async () => {
    // `cloudflare:test` の `env` は wrangler.test.jsonc の vars から型が
    // 生成されるため、そこに無いキー（本番のみの NOTIFY_WEBHOOK_URL 等）は
    // 型に現れない。テスト内で注入するのでここだけ緩めた型で見る。
    const testEnv = env as typeof env & {
      NOTIFY_WEBHOOK_URL?: string
      ENABLE_AUTO_TAGS?: string
      AI: unknown
    }

    const notified: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        // タグ生成は本文 200 文字超でしか走らない（wantTags の条件）。
        // 短い本文だと生成自体がスキップされ、通知が無いことを合格と
        // 読み違える。
        return new Response(`Title: T\n\n${'Body content here. '.repeat(20)}`, {
          status: 200,
        })
      }
      if (u.startsWith('https://webhook.test/')) {
        notified.push(String((init as RequestInit | undefined)?.body ?? ''))
        return new Response('ok', { status: 200 })
      }
      return new Response('upstream error', { status: 500 })
    })

    const original = {
      notify: testEnv.NOTIFY_WEBHOOK_URL,
      autoTags: testEnv.ENABLE_AUTO_TAGS,
      ai: testEnv.AI,
    }
    testEnv.NOTIFY_WEBHOOK_URL = 'https://webhook.test/notify'
    testEnv.ENABLE_AUTO_TAGS = 'true'
    // anthropic 経路は失敗しても workers-ai へフォールバックするだけで throw しない。
    // generateTags を実際に reject させるには最終段の AI バインディングを落とす。
    testEnv.AI = {
      run: async () => {
        throw new Error('AI unavailable')
      },
    } as unknown as typeof testEnv.AI
    try {
      const res = await SELF.fetch('http://example.com/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SHARED_SECRET}`,
        },
        body: JSON.stringify({
          url: 'https://unknown-host-xyz.example/a/tag-notify-1',
        }),
      })
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
      expect(
        notified.some((b) => b.includes('タグ生成失敗')),
        `タグ生成失敗の通知が飛んでいない: ${JSON.stringify(notified)}`,
      ).toBe(true)
    } finally {
      testEnv.NOTIFY_WEBHOOK_URL = original.notify
      testEnv.ENABLE_AUTO_TAGS = original.autoTags
      testEnv.AI = original.ai
    }
  })

  /// urls.json が壊れていて writeUrlIndexCAS が書き込みをスキップしたとき、
  /// 本文取得/要約/タグ生成と同じく webhook へ通知すること（#101）。
  ///
  /// #92 で「空インデックスで上書きしない」対応は入ったが、通知は
  /// console.warn 止まりで追加されなかった。urls.json が一度壊れると、
  /// ノート自体は保存され続けるのに重複検知だけが気づかれずに劣化し続ける。
  it('notifies the webhook when the url index is corrupted and the write is skipped', async () => {
    const testEnv = env as typeof env & { NOTIFY_WEBHOOK_URL?: string }
    const original = testEnv.NOTIFY_WEBHOOK_URL

    // 他のテストが同じ本番 index key (Inbox/.index/urls.json) を共有しているため、
    // 壊す前の内容を退避して必ず復元する。復元しないと後続テストの重複検知が壊れる。
    const indexKey = 'Inbox/.index/urls.json'
    const previous = await env.VAULT.get(indexKey)
    const previousBody = previous ? await previous.text() : null
    await env.VAULT.put(indexKey, '{ this is not valid json')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const notified: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = input.toString()
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('Title: T\n\nBody content here.', { status: 200 })
      }
      if (u.startsWith('https://webhook.test/')) {
        notified.push(String((init as RequestInit | undefined)?.body ?? ''))
        return new Response('ok', { status: 200 })
      }
      return new Response('upstream error', { status: 500 })
    })

    testEnv.NOTIFY_WEBHOOK_URL = 'https://webhook.test/notify'
    try {
      const res = await SELF.fetch('http://example.com/clip', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SHARED_SECRET}`,
        },
        body: JSON.stringify({
          url: 'https://unknown-host-xyz.example/a/index-corrupt-notify-1',
        }),
      })
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
      expect(
        notified.some((b) =>
          b.includes('重複検知インデックスの更新をスキップ'),
        ),
        `index 破損の通知が飛んでいない: ${JSON.stringify(notified)}`,
      ).toBe(true)

      // index 自体は上書きされていない (#92 の不変条件を維持)。
      const stored = await env.VAULT.get(indexKey)
      expect(await stored?.text()).toBe('{ this is not valid json')
    } finally {
      testEnv.NOTIFY_WEBHOOK_URL = original
      warnSpy.mockRestore()
      if (previousBody === null) {
        await env.VAULT.delete(indexKey)
      } else {
        await env.VAULT.put(indexKey, previousBody)
      }
    }
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

// ─────────── Integration: text/markdown clip (ADR 0011) ───────────

describe('POST /clip - text/markdown clip', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const postJson = (body: unknown) =>
    SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify(body),
    })

  it('saves a markdown body under Inbox/ with source: text-clip', async () => {
    const res = await postJson({
      markdown: '# Hello\n\nSome body content.',
      tags: ['test'],
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; path: string }
    expect(json.ok).toBe(true)
    expect(json.path).toMatch(/Inbox\/.*\.md$/)

    const stored = await env.VAULT.get(json.path)
    expect(stored).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('source: text-clip')
    expect(content).not.toContain('source_url:')
    expect(content).toContain('Some body content.')
    expect(content).toContain('- "clipped"')
    expect(content).toContain('- "test"')
  })

  it('saves a plaintext body via the text field', async () => {
    const res = await postJson({ text: 'just a plain note', note: 'memo' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; path: string }
    expect(json.ok).toBe(true)

    const stored = await env.VAULT.get(json.path)
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('source: text-clip')
    expect(content).toContain('just a plain note')
    expect(content).toContain('memo')
  })

  it('returns 400 when neither url nor markdown/text is present', async () => {
    const res = await postJson({ title: 'nothing useful' })
    expect(res.status).toBe(400)
  })
})

// ─────────── Integration: image clip (multipart/form-data, ADR 0011) ───────────

describe('エラーレスポンスの形（#77）', () => {
  // README は全エラーを `{ ok: false, error: ... }` と明記しているが、
  // onError が HTTPException をそのまま返していたため **4xx はプレーンテキスト**
  // だった（500 だけが JSON という非対称）。クライアントは成功時に JSON を
  // 読むので、エラー時だけ形が変わるとパースに失敗して原因不明の失敗になる。
  it('400 が JSON で返る', async () => {
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SHARED_SECRET}`,
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: boolean; error: string }
    expect(json.ok).toBe(false)
    expect(json.error).toBeTruthy()
  })

  it('401 が JSON で返る', async () => {
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/a' }),
    })

    expect(res.status).toBe(401)
    const json = (await res.json()) as { ok: boolean; error: string }
    expect(json.ok).toBe(false)
  })
})

describe('resolveMaxImageBytes', () => {
  // 不正な値でも既定へ倒れる（#77）。env の設定ミスで画像クリップ全体が
  // 壊れるより、既定の 10 MiB で動き続けるほうがよい、という判断の固定。
  it('未設定なら既定値', () => {
    expect(resolveMaxImageBytes(undefined)).toBe(DEFAULT_MAX_IMAGE_BYTES)
  })

  it('数値として解釈できない値なら既定値', () => {
    expect(resolveMaxImageBytes('abc')).toBe(DEFAULT_MAX_IMAGE_BYTES)
    expect(resolveMaxImageBytes('')).toBe(DEFAULT_MAX_IMAGE_BYTES)
  })

  it('0 以下なら既定値（全画像を拒否する設定にしない）', () => {
    expect(resolveMaxImageBytes('0')).toBe(DEFAULT_MAX_IMAGE_BYTES)
    expect(resolveMaxImageBytes('-1')).toBe(DEFAULT_MAX_IMAGE_BYTES)
  })

  it('正の数はそのまま使う', () => {
    expect(resolveMaxImageBytes('1024')).toBe(1024)
  })
})

describe('POST /clip - image clip', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const pngBytes = (seed: number) =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, seed + 1, seed + 2])

  const postImage = (
    fields: Record<string, string> = {},
    filename = 'shot.png',
    bytes = pngBytes(1),
  ) => {
    const form = new FormData()
    form.set('image', new File([bytes], filename, { type: 'image/png' }))
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    return SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SHARED_SECRET}` },
      body: form,
    })
  }

  /// MAX_IMAGE_BYTES を超える画像を 413 で拒否すること（#77）。
  ///
  /// README が API レスポンスとして明記している分岐だが、テストが無かった。
  /// テスト env の MAX_IMAGE_BYTES は 10 MiB なので、10 MiB のダミーを送るより
  /// **env を一時的に小さくして**境界を跨がせる（巨大なバッファを作らない）。
  it('MAX_IMAGE_BYTES を超える画像を 413 で拒否する', async () => {
    const testEnv = env as typeof env & { MAX_IMAGE_BYTES?: string }
    const original = testEnv.MAX_IMAGE_BYTES
    testEnv.MAX_IMAGE_BYTES = '4'
    try {
      // 7 バイト > 4 バイト。
      const res = await postImage({}, 'too-large-1.png', pngBytes(20))

      expect(res.status).toBe(413)
      const json = (await res.json()) as { ok: boolean; error: string }
      expect(json.ok).toBe(false)
      expect(json.error).toContain('too large')
    } finally {
      testEnv.MAX_IMAGE_BYTES = original
    }
  })

  /// urls.json が壊れていて writeUrlIndexCAS が書き込みをスキップしたとき、
  /// image clip でも webhook へ通知すること（#101）。URL clip と同じ index
  /// (`Inbox/.index/urls.json`) を共有しているため、破損の影響は両経路に及ぶ。
  it('notifies the webhook when the url index is corrupted and the write is skipped', async () => {
    const testEnv = env as typeof env & { NOTIFY_WEBHOOK_URL?: string }
    const original = testEnv.NOTIFY_WEBHOOK_URL

    // 他のテストが同じ本番 index key (Inbox/.index/urls.json) を共有しているため、
    // 壊す前の内容を退避して必ず復元する。復元しないと後続テストの重複検知が壊れる。
    const indexKey = 'Inbox/.index/urls.json'
    const previous = await env.VAULT.get(indexKey)
    const previousBody = previous ? await previous.text() : null
    await env.VAULT.put(indexKey, '{ this is not valid json')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const notified: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = input.toString()
      if (u.startsWith('https://webhook.test/')) {
        notified.push(String((init as RequestInit | undefined)?.body ?? ''))
        return new Response('ok', { status: 200 })
      }
      return new Response('upstream error', { status: 500 })
    })

    testEnv.NOTIFY_WEBHOOK_URL = 'https://webhook.test/notify'
    try {
      const res = await postImage(
        {},
        'index-corrupt-notify-1.png',
        pngBytes(30),
      )
      expect(res.status).toBe(200)
      expect(
        notified.some((b) =>
          b.includes('重複検知インデックスの更新をスキップ'),
        ),
        `index 破損の通知が飛んでいない: ${JSON.stringify(notified)}`,
      ).toBe(true)

      const stored = await env.VAULT.get(indexKey)
      expect(await stored?.text()).toBe('{ this is not valid json')
    } finally {
      testEnv.NOTIFY_WEBHOOK_URL = original
      warnSpy.mockRestore()
      if (previousBody === null) {
        await env.VAULT.delete(indexKey)
      } else {
        await env.VAULT.put(indexKey, previousBody)
      }
    }
  })

  it('上限ちょうどのサイズは受け入れる（境界は > で判定）', async () => {
    const testEnv = env as typeof env & { MAX_IMAGE_BYTES?: string }
    const original = testEnv.MAX_IMAGE_BYTES
    // pngBytes は 7 バイト。ちょうど 7 なら通る。
    testEnv.MAX_IMAGE_BYTES = '7'
    try {
      const res = await postImage({}, 'exactly-max-1.png', pngBytes(21))
      expect(res.status).toBe(200)
    } finally {
      testEnv.MAX_IMAGE_BYTES = original
    }
  })

  it('saves an image under Attachments/ without an embed note by default', async () => {
    const res = await postImage({}, 'unique-shot-1.png', pngBytes(10))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      path: string
      embedded: boolean
      bytes: number
    }
    expect(json.ok).toBe(true)
    expect(json.path).toMatch(/Attachments\/.*\.png$/)
    expect(json.embedded).toBe(false)

    const stored = await env.VAULT.get(json.path)
    expect(stored).not.toBeNull()
    expect(stored?.httpMetadata?.contentType).toBe('image/png')
  })

  it('generates an embed note under Inbox/ when embed=1 is set', async () => {
    const res = await postImage(
      { embed: '1', title: 'My Screenshot' },
      'unique-shot-2.png',
      pngBytes(20),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      embedded: boolean
      notePath?: string
    }
    expect(json.ok).toBe(true)
    expect(json.embedded).toBe(true)
    expect(json.notePath).toMatch(/Inbox\/.*\.md$/)

    const stored = await env.VAULT.get(json.notePath as string)
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('source: image-clip')
    expect(content).toContain('![[Attachments/')
    expect(content).toContain('My Screenshot')
  })

  it('returns 415 for unsupported image types', async () => {
    const form = new FormData()
    form.set(
      'image',
      new File([new Uint8Array([1, 2, 3])], 'doc.pdf', {
        type: 'application/pdf',
      }),
    )
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SHARED_SECRET}` },
      body: form,
    })
    expect(res.status).toBe(415)
  })

  it('returns 400 when no image field is present', async () => {
    const form = new FormData()
    form.set('title', 'no image here')
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SHARED_SECRET}` },
      body: form,
    })
    expect(res.status).toBe(400)
  })

  it('returns duplicate:true when the same image bytes are posted twice', async () => {
    const bytes = pngBytes(99)
    const res1 = await postImage({}, 'dup-shot-1.png', bytes)
    expect(res1.status).toBe(200)
    const json1 = (await res1.json()) as { ok: boolean; path: string }
    expect(json1.ok).toBe(true)

    // Different filename, same bytes → same content hash.
    const res2 = await postImage({}, 'dup-shot-2.png', bytes)
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

  it('duplicate bytes with an embed intent still create an embed note referencing the existing image (#99)', async () => {
    const bytes = pngBytes(120)
    const res1 = await postImage({}, 'dup-embed-1.png', bytes)
    expect(res1.status).toBe(200)
    const json1 = (await res1.json()) as { ok: boolean; path: string }
    expect(json1.ok).toBe(true)

    const res2 = await postImage(
      { title: 'メモ追記' },
      'dup-embed-2.png',
      bytes,
    )
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as {
      ok: boolean
      duplicate: boolean
      path: string
      embedded: boolean
      notePath?: string
    }
    expect(json2.ok).toBe(false)
    expect(json2.duplicate).toBe(true)
    expect(json2.path).toBe(json1.path)
    expect(json2.embedded).toBe(true)
    expect(json2.notePath).toMatch(/Inbox\/.*\.md$/)

    // The image itself was not re-uploaded; the note references the existing path.
    const stored = await env.VAULT.get(json2.notePath as string)
    // biome-ignore lint/style/noNonNullAssertion: assertion above guarantees non-null
    const content = await stored!.text()
    expect(content).toContain('source: image-clip')
    expect(content).toContain('メモ追記')
    expect(content).toContain(
      `![[${json1.path.replace(/^.*Attachments\//, 'Attachments/')}]]`,
    )
  })

  it('duplicate bytes without an embed intent report embedded:false (#99)', async () => {
    const bytes = pngBytes(140)
    const res1 = await postImage({}, 'dup-no-embed-1.png', bytes)
    expect(res1.status).toBe(200)

    const res2 = await postImage({}, 'dup-no-embed-2.png', bytes)
    const json2 = (await res2.json()) as {
      ok: boolean
      duplicate: boolean
      embedded: boolean
      notePath?: string
    }
    expect(json2.ok).toBe(false)
    expect(json2.duplicate).toBe(true)
    expect(json2.embedded).toBe(false)
    expect(json2.notePath).toBeUndefined()
  })

  it('returns 401 when Authorization header is missing (multipart too)', async () => {
    const form = new FormData()
    form.set(
      'image',
      new File([pngBytes(1)], 'shot.png', { type: 'image/png' }),
    )
    const res = await SELF.fetch('http://example.com/clip', {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(401)
  })
})
