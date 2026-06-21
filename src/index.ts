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

export type Bindings = {
  VAULT: R2Bucket
  AI: Ai
  SHARED_SECRET: string
  VAULT_PREFIX: string
  INBOX_FOLDER: string
  ENABLE_SUMMARY: string
  SUMMARY_MODEL: string
  ENABLE_AUTO_TAG?: string
  JINA_API_KEY?: string
  SUMMARY_PROVIDER?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  NOTIFY_WEBHOOK_URL?: string
  CF_ACCOUNT_ID?: string
  BROWSER_RENDERING_API_TOKEN?: string
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

  const refresh = c.req.query('refresh') === '1'

  // ---- 0. 重複検知 ----
  const folder = (c.env.INBOX_FOLDER || 'Inbox').replace(/^\/+|\/+$/g, '')
  const prefix = (c.env.VAULT_PREFIX || '').replace(/^\/+/, '')
  const indexKey = `${prefix}${folder}/.index/urls.json`
  const hash = await sha1Hex(url)

  const urlIndex = await readUrlIndex(c.env.VAULT, indexKey)
  if (!refresh && urlIndex[hash]) {
    return c.json({ ok: false, duplicate: true, path: urlIndex[hash].path })
  }

  // ---- 1. 本文取得 (Jina Reader + リトライ + Browser Rendering フォールバック) ----
  const article = await fetchArticle(url, c.env)
  const articleMd = article.md
  const articleTitle: string | undefined =
    payload.title?.trim() || article.title
  const fetchErr = article.err
  if (fetchErr && c.env.NOTIFY_WEBHOOK_URL) {
    c.executionCtx.waitUntil(
      notifyWebhook(
        c.env.NOTIFY_WEBHOOK_URL,
        `[obsidian-clipper] 本文取得失敗: ${url} (${fetchErr})`,
      ),
    )
  }

  // ---- 2. 要約 (Workers AI, 任意) ----
  let summary = ''
  if (c.env.ENABLE_SUMMARY === 'true' && articleMd && articleMd.length > 200) {
    try {
      summary = await summarizeWithProvider(c.env, articleMd, articleTitle)
    } catch (e) {
      console.warn('summarize failed', (e as Error).message)
      if (c.env.NOTIFY_WEBHOOK_URL) {
        c.executionCtx.waitUntil(
          notifyWebhook(
            c.env.NOTIFY_WEBHOOK_URL,
            `[obsidian-clipper] 要約失敗: ${url} (${(e as Error).message})`,
          ),
        )
      }
    }
  }

  // ---- 2.5 タグ統合 (clipped + ユーザ + allowlist + LLM) ----
  const hostTags = hostTagsFor(url)
  let llmTags: string[] = []
  if (c.env.ENABLE_AUTO_TAG === 'true' && articleMd && articleMd.length > 200) {
    try {
      llmTags = await generateTags(c.env, articleMd, articleTitle)
    } catch (e) {
      console.warn('auto-tag failed', (e as Error).message)
    }
  }
  const tags = mergeTags([
    'clipped',
    ...(payload.tags ?? []),
    ...hostTags,
    ...llmTags,
  ])

  // ---- 3. 保存パス決定 ----
  const now = new Date()
  const stamp = jstStamp(now)
  const slug =
    sanitizeForFilename(articleTitle || hostname(url) || 'clip').slice(0, 60) ||
    'clip'
  const filename = `${stamp}_${slug}.md`
  const key = `${prefix}${folder}/${filename}`

  // ---- 4. ノート本文を組み立てて R2 に書き込み ----
  const body = renderNote({
    url,
    title: articleTitle,
    summary,
    note: payload.note,
    selection: payload.selection,
    tags,
    body: articleMd,
    createdIso: jstIso(now),
    fetchErr,
  })

  await c.env.VAULT.put(key, body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: {
      source: 'obsidian-clipper',
      url,
      ...(article.via ? { via: article.via } : {}),
    },
  })

  // ---- 5. インデックス更新 ----
  urlIndex[hash] = { path: key, createdAt: jstIso(now) }
  await writeUrlIndex(c.env.VAULT, indexKey, urlIndex)

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

// ─────────────────────────── article fetch ───────────────────────────

type FetchedArticle = {
  md: string
  title?: string
  via?: 'jina' | 'jina-retry' | 'browser-rendering'
  err?: string
}

// 1 リクエストごとのタイムアウト / リトライ設定 (個人ツール想定で定数)
const JINA_TIMEOUT_MS = 20_000
const BROWSER_RENDERING_TIMEOUT_MS = 30_000
const JINA_MAX_RETRIES = 2
const JINA_RETRY_STATUS = new Set([429, 503])

function extractJinaTitle(md: string): string | undefined {
  const m = md.match(/^Title:\s*(.+)$/m)
  return m ? m[1].trim() : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 本文取得。Jina Reader を指数バックオフでリトライ (429/503 のみ) し、
 * 最終的に失敗したら Browser Rendering の /markdown にフォールバックする。
 * すべて失敗しても throw せず { md: '', err } を返す (失敗時 200 の不変条件)。
 */
export async function fetchArticle(
  url: string,
  env: Bindings,
): Promise<FetchedArticle> {
  let lastErr: string | undefined
  for (let attempt = 0; attempt <= JINA_MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = { Accept: 'text/plain' }
      if (env.JINA_API_KEY) {
        headers.Authorization = `Bearer ${env.JINA_API_KEY}`
      }
      const res = await fetchWithTimeout(
        `https://r.jina.ai/${url}`,
        { headers, cf: { cacheTtl: 0 } },
        JINA_TIMEOUT_MS,
      )
      if (res.ok) {
        const md = await res.text()
        return {
          md,
          title: extractJinaTitle(md),
          via: attempt === 0 ? 'jina' : 'jina-retry',
        }
      }
      lastErr = `jina ${res.status}`
      // リトライ対象ステータスかつ残り回数があるときだけ待って再試行
      if (JINA_RETRY_STATUS.has(res.status) && attempt < JINA_MAX_RETRIES) {
        const wait = retryDelayMs(res, attempt)
        await sleep(wait)
        continue
      }
      break
    } catch (e) {
      lastErr = `jina ${(e as Error).message}`
      if (attempt < JINA_MAX_RETRIES) {
        await sleep(retryDelayMs(null, attempt))
        continue
      }
      break
    }
  }

  // ---- Browser Rendering フォールバック (設定済みの場合のみ) ----
  if (env.CF_ACCOUNT_ID && env.BROWSER_RENDERING_API_TOKEN) {
    try {
      const md = await fetchViaBrowserRendering(url, env)
      if (md) {
        return { md, title: extractJinaTitle(md), via: 'browser-rendering' }
      }
      lastErr = `${lastErr ?? 'jina failed'}; browser-rendering empty`
    } catch (e) {
      lastErr = `${lastErr ?? 'jina failed'}; browser-rendering ${(e as Error).message}`
    }
  }

  return { md: '', err: lastErr ?? 'fetch failed' }
}

// Retry-After (秒) を尊重しつつ、無ければ指数バックオフ (0.5s, 1s, ...)
function retryDelayMs(res: Response | null, attempt: number): number {
  if (res) {
    const ra = res.headers.get('retry-after')
    if (ra) {
      const sec = Number(ra)
      if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 10_000)
    }
  }
  return 500 * 2 ** attempt
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchViaBrowserRendering(
  url: string,
  env: Bindings,
): Promise<string> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.BROWSER_RENDERING_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url }),
    },
    BROWSER_RENDERING_TIMEOUT_MS,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  // REST API は { success, result } を返す。result が文字列 (markdown) 想定。
  const data = (await res.json()) as {
    success?: boolean
    result?: string | { markdown?: string }
    errors?: unknown
  }
  if (typeof data.result === 'string') return data.result.trim()
  if (data.result && typeof data.result.markdown === 'string') {
    return data.result.markdown.trim()
  }
  return ''
}

// ─────────────────────────── tags ───────────────────────────

const MAX_AUTO_TAGS = 3
// LLM 生成タグを除いた最終タグ件数の上限 (clipped + user + host + llm を統合後に打ち切る)
const MAX_TOTAL_TAGS = 8

// ホスト名サフィックス → 固定タグ。LLM 不要で確実に付与する allowlist。
const HOST_TAG_RULES: ReadonlyArray<[string, string]> = [
  ['zenn.dev', 'zenn'],
  ['qiita.com', 'qiita'],
  ['note.com', 'note'],
  ['hatenablog.com', 'hatena'],
  ['hatena.ne.jp', 'hatena'],
  ['x.com', 'x'],
  ['github.com', 'github'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['speakerdeck.com', 'slides'],
]

// Obsidian / Dataview のタグで扱いにくい文字を除去し、空白はハイフン化して正規化する。
// 戻り値が空文字なら呼び出し側で捨てる。
export function normalizeTag(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
}

// 複数ソースのタグを正規化 → 重複排除 → 上限で打ち切る。
export function mergeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const n = normalizeTag(t)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= MAX_TOTAL_TAGS) break
  }
  return out
}

// ホスト名 allowlist 照合。サブドメインも後方一致で拾う (例: foo.hatenablog.com)。
export function hostTagsFor(url: string): string[] {
  const h = hostname(url)
  if (!h) return []
  const tags: string[] = []
  for (const [suffix, tag] of HOST_TAG_RULES) {
    if (h === suffix || h.endsWith(`.${suffix}`)) tags.push(tag)
  }
  return tags
}

const AUTO_TAG_SYSTEM_PROMPT =
  'あなたは技術記事にタグを付けるアシスタントです。' +
  '記事内容を表すタグを最大3個、半角カンマ区切りで出力してください。' +
  '各タグは小文字の短い英単語または日本語の固有名詞短語にし、説明文や記号は付けず、タグのみを出力してください。'

function parseTagList(s: string): string[] {
  return s
    .split(/[,\n、]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_AUTO_TAGS)
}

// 本文 + タイトルから LLM でタグを最大 MAX_AUTO_TAGS 個生成する。
// 要約と同じ provider 設計 (Anthropic / workers-ai) を踏襲。失敗時は throw。
async function generateTags(
  env: Bindings,
  md: string,
  title: string | undefined,
): Promise<string[]> {
  const userPrompt = buildSummaryUserPrompt(md, title)
  if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    try {
      const text = await anthropicComplete(
        env.ANTHROPIC_API_KEY,
        env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
        AUTO_TAG_SYSTEM_PROMPT,
        userPrompt,
        60,
      )
      return parseTagList(text)
    } catch (e) {
      console.warn(
        'anthropic auto-tag failed, falling back to workers-ai',
        (e as Error).message,
      )
    }
  }
  const model = env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct'
  const r = (await env.AI.run(
    model as Parameters<Ai['run']>[0],
    {
      messages: [
        { role: 'system', content: AUTO_TAG_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 60,
    } as never,
  )) as { response?: string }
  return parseTagList((r?.response ?? '').toString())
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

function summarizeWithAnthropic(
  apiKey: string,
  model: string,
  md: string,
  title: string | undefined,
): Promise<string> {
  return anthropicComplete(
    apiKey,
    model,
    SUMMARY_SYSTEM_PROMPT,
    buildSummaryUserPrompt(md, title),
    300,
  )
}

// Anthropic Messages API の汎用 1 往復呼び出し。system/user/max_tokens を受け取り
// テキストを返す。失敗時は throw (呼び出し側でフォールバック/degrade を判断)。
async function anthropicComplete(
  apiKey: string,
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
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
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userPrompt }],
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

type IndexEntry = { path: string; createdAt: string }
type UrlIndex = Record<string, IndexEntry>

export async function sha1Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-1', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function readUrlIndex(vault: R2Bucket, key: string): Promise<UrlIndex> {
  const obj = await vault.get(key)
  if (!obj) return {}
  try {
    return (await obj.json()) as UrlIndex
  } catch {
    return {}
  }
}

async function writeUrlIndex(
  vault: R2Bucket,
  key: string,
  index: UrlIndex,
): Promise<void> {
  await vault.put(key, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
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

async function notifyWebhook(url: string, message: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
    })
  } catch (e) {
    console.warn('webhook notify failed', (e as Error).message)
  }
}
