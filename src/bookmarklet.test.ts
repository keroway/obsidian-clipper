import { describe, expect, it } from 'vitest'
import source from '../client/bookmarklet.js?raw'

// ブックマークレットを偽のグローバルで実行し、表示されたトーストを集める
async function run(status: number, body: string) {
  const toasts: { text: string; background: string }[] = []
  const win = { getSelection: () => '' }
  const loc = { href: 'https://example.com/a' }
  const doc = {
    title: 'T',
    createElement: () => ({
      style: {} as Record<string, string>,
      textContent: '',
      remove() {},
    }),
    body: {
      appendChild(el: { textContent: string; style: Record<string, string> }) {
        toasts.push({ text: el.textContent, background: el.style.background })
      },
    },
  }
  const fakeFetch = async () => new Response(body, { status })
  const fn = new Function(
    'window',
    'location',
    'document',
    'fetch',
    'setTimeout',
    source,
  )
  fn(win, loc, doc, fakeFetch, () => 0)
  await new Promise((r) => setTimeout(r, 20))
  return toasts
}

describe('bookmarklet の結果表示', () => {
  it('ok:true と path があれば Saved を緑で表示する', async () => {
    const t = await run(200, '{"ok":true,"path":"Inbox/example.md"}')
    expect(t).toEqual([
      { text: 'Saved: Inbox/example.md', background: '#16a34a' },
    ])
  })

  it('重複応答は Already saved を表示する', async () => {
    const t = await run(200, '{"ok":true,"duplicate":true,"path":"Inbox/x.md"}')
    expect(t[0].text).toBe('Already saved: Inbox/x.md')
    expect(t[0].background).toBe('#dc2626')
  })

  it('HTTP 200 でも ok:false なら成功表示にしない', async () => {
    const t = await run(200, '{"ok":false,"error":"storage failed"}')
    expect(t[0].text).toContain('Error 200')
    expect(t[0].background).toBe('#dc2626')
  })

  it('HTTP 200 の空オブジェクトは成功表示にしない', async () => {
    const t = await run(200, '{}')
    expect(t[0].text).toContain('Error 200')
    expect(t[0].background).toBe('#dc2626')
  })
})
