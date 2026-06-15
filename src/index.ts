/**
 * obsidian-clipper
 *
 * URL (+任意のメモ/抜粋/タグ) を受け取って、
 *   1. URL を正規化 (トラッキングパラメータ除去)
 *   2. Jina Reader (https://r.jina.ai/) で本文 Markdown を取得
 *   3. (任意) Workers AI で要約
 *   4. frontmatter 付き Markdown を生成
 *   5. R2 (= Remotely Save の Vault バケット) の Inbox/ に PUT
 * を行う Cloudflare Worker。
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'

type Bindings = {
  VAULT: R2Bucket
  AI: Ai
  SHARED_SECRET: string
  VAULT_PREFIX: string
  INBOX_FOLDER: string
  ENABLE_SUMMARY: string
  SUMMARY_MODEL: string
  JINA_API_KEY?: string
  SUMMARY_PROVIDER?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
}

type ClipBody = {
  url: string
  title?: string
  selection?: string
  note?: string
  tags?: string[]
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) =>
  c.text(
    [
      'obsidian-clipper',
      '',
      'POST /clip',
      '  Authorization: Bearer <SHARED_SECRET>',
      '  Content-Type: application/json',
      '  Body: { "url": string, "title"?: string, "selection"?: string, "note"?: string, "tags"?: string[] }',
    ].join('\n'),
  ),
)

// ブックマークレットや iOS ショートカットから叩くので CORS は緩めに
app.use(
  '/clip',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
)

app.use(
  '/clip',
  bearerAuth({
    verifyToken: (token: string, c: Context<{ Bindings: Bindings }>) =>
      token === c.env.SHARED_SECRET,
  }),
)

app.post('/clip', async (c) => {
  let payload: ClipBody
  try {
    payload = await c.req.json<ClipBody>()
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' })
  }
  if (!payload?.url || typeof payload.url !== 'string') {
    throw new HTTPException(400, { message: 'url is required (string)' })
  }

  const url = normalizeUrl(payload.url)

  // ---- 1. 本文取得 (Jina Reader) ----
  let articleMd = ''
  let articleTitle: string | undefined = payload.title?.trim() || undefined
  let fetchErr: string | undefined
  try {
    const headers: Record<string, string> = { Accept: 'text/plain' }
    if (c.env.JINA_API_KEY) {
      headers.Authorization = `Bearer ${c.env.JINA_API_KEY}`
    }
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      cf: { cacheTtl: 0 },
    })
    if (res.ok) {
      articleMd = await res.text()
      if (!articleTitle) {
        const m = articleMd.match(/^Title:\s*(.+)$/m)
        if (m) articleTitle = m[1].trim()
      }
    } else {
      fetchErr = `jina ${res.status}`
    }
  } catch (e) {
    fetchErr = `jina ${(e as Error).message}`
  }

  // ---- 2. 要約 (Workers AI, 任意) ----
  let summary = ''
  if (c.env.ENABLE_SUMMARY === 'true' && articleMd && articleMd.length > 200) {
    try {
      summary = await summarizeWithProvider(c.env, articleMd, articleTitle)
    } catch (e) {
      console.warn('summarize failed', (e as Error).message)
    }
  }

  // ---- 3. 保存パス決定 ----
  const now = new Date()
  const stamp = jstStamp(now)
  const slug =
    sanitizeForFilename(articleTitle || hostname(url) || 'clip').slice(0, 60) ||
    'clip'
  const filename = `${stamp}_${slug}.md`
  const folder = (c.env.INBOX_FOLDER || 'Inbox').replace(/^\/+|\/+$/g, '')
  const prefix = (c.env.VAULT_PREFIX || '').replace(/^\/+/, '')
  const key = `${prefix}${folder}/${filename}`

  // ---- 4. ノート本文を組み立てて R2 に書き込み ----
  const body = renderNote({
    url,
    title: articleTitle,
    summary,
    note: payload.note,
    selection: payload.selection,
    tags: payload.tags,
    body: articleMd,
    createdIso: jstIso(now),
    fetchErr,
  })

  await c.env.VAULT.put(key, body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: { source: 'obsidian-clipper', url },
  })

  return c.json({
    ok: true,
    path: key,
    bytes: body.length,
    summarized: !!summary,
  })
})

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('unhandled', err)
  return c.json({ ok: false, error: err.message }, 500)
})

export default app

// ─────────────────────────── utilities ───────────────────────────

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
  'si',
  '_hsenc',
  '_hsmi',
  's', // X (Twitter) の共有用
  't', // X (Twitter) の共有用
])

export function normalizeUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new HTTPException(400, { message: 'invalid url' })
  }
  // X (旧 Twitter) ドメイン揺れの正規化
  if (u.hostname === 'mobile.twitter.com' || u.hostname === 'twitter.com') {
    u.hostname = 'x.com'
  }
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k)) u.searchParams.delete(k)
  }
  // 末尾の / は残す/消すで割れるので触らない
  return u.toString()
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function jstStamp(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
    `_${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
  )
}

function jstIso(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
    `T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}+09:00`
  )
}

// Windows / macOS / Obsidian で扱いにくい文字
const INVALID_FILENAME_RE = /[\\/:*?"<>|[\]#^`]/g
export function sanitizeForFilename(name: string): string {
  return name
    .slice(0, 200)
    .replace(INVALID_FILENAME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
}

function yamlEscape(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// モデルのコンテキストに収めるため先頭を切り出す上限
const SUMMARY_EXCERPT_LIMIT = 6000
const SUMMARY_SYSTEM_PROMPT =
  'あなたは技術記事を日本語で要約するアシスタントです。' +
  '出力は3〜5文の散文で、最初の1文に結論を置き、専門用語はそのまま残してください。' +
  '箇条書きや見出しは使わないでください。'
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000

function buildSummaryUserPrompt(md: string, title: string | undefined): string {
  const excerpt = md.slice(0, SUMMARY_EXCERPT_LIMIT)
  return [title ? `タイトル: ${title}` : '', '本文:', excerpt]
    .filter(Boolean)
    .join('\n')
}

async function summarizeWithProvider(
  env: Bindings,
  md: string,
  title: string | undefined,
): Promise<string> {
  const workersAiModel = env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct'
  if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    const anthropicModel = env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL
    try {
      return await summarizeWithAnthropic(
        env.ANTHROPIC_API_KEY,
        anthropicModel,
        md,
        title,
      )
    } catch (e) {
      // Anthropic 失敗時は 1 回だけ workers-ai にフォールバック (ループは作らない)
      console.warn(
        'anthropic summarize failed, falling back to workers-ai',
        (e as Error).message,
      )
      return await summarize(env.AI, workersAiModel, md, title)
    }
  }
  return await summarize(env.AI, workersAiModel, md, title)
}

async function summarize(
  ai: Ai,
  model: string,
  md: string,
  title: string | undefined,
): Promise<string> {
  const r = (await ai.run(
    model as Parameters<Ai['run']>[0],
    {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryUserPrompt(md, title) },
      ],
      max_tokens: 300,
    } as never,
  )) as { response?: string }
  return (r?.response ?? '').toString().trim()
}

async function summarizeWithAnthropic(
  apiKey: string,
  model: string,
  md: string,
  title: string | undefined,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildSummaryUserPrompt(md, title) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(
        `anthropic ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      )
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

export function renderNote(opts: {
  url: string
  title?: string
  summary: string
  note?: string
  selection?: string
  tags?: string[]
  body: string
  createdIso: string
  fetchErr?: string
}): string {
  // ---- frontmatter ----
  const fm: string[] = ['---']
  fm.push(`created: ${opts.createdIso}`)
  fm.push(`updated: ${opts.createdIso}`)
  fm.push('source: web-clip')
  fm.push(`source_url: ${yamlEscape(opts.url)}`)
  if (opts.title) fm.push(`source_title: ${yamlEscape(opts.title)}`)
  const tags = unique(['clipped', ...(opts.tags ?? [])])
  fm.push('tags:')
  for (const t of tags) fm.push(`  - ${yamlEscape(t)}`)
  if (opts.summary) {
    fm.push(`summary: ${yamlEscape(opts.summary.replace(/\s+/g, ' '))}`)
  }
  fm.push('---')

  // ---- body ----
  const parts: string[] = [fm.join('\n'), '']
  if (opts.title) parts.push(`# ${opts.title}`, '')
  parts.push(`<${opts.url}>`, '')

  if (opts.note) {
    parts.push('> [!note] メモ')
    parts.push(`> ${opts.note.replace(/\n/g, '\n> ')}`)
    parts.push('')
  }
  if (opts.summary) {
    parts.push('## 要約')
    parts.push(opts.summary)
    parts.push('')
  }
  if (opts.selection) {
    parts.push('## 抜粋')
    parts.push(`> ${opts.selection.replace(/\n/g, '\n> ')}`)
    parts.push('')
  }
  if (opts.body) {
    parts.push('## 本文')
    parts.push(opts.body)
    parts.push('')
  } else if (opts.fetchErr) {
    parts.push('## 本文')
    parts.push(
      `> 本文取得に失敗しました (${opts.fetchErr}). 後で手動で開いてください。`,
    )
    parts.push('')
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n')
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}
