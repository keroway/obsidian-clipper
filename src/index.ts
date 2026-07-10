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
 *
 * ルータ本体のみをここに置く。ロジックは責務ごとに以下へ分割している:
 *   src/bindings.ts     — Bindings 型
 *   src/url.ts          — normalizeUrl / hostname
 *   src/fetch-article.ts — Jina Reader 取得 + Browser Rendering フォールバック
 *   src/llm.ts          — 要約・タグ生成 (Workers AI / Anthropic)
 *   src/tags.ts         — タグ正規化・統合・ホスト名 allowlist
 *   src/note.ts         — renderNote / ファイル名サニタイズ
 *   src/url-index.ts    — URL 重複検知インデックス
 *   src/notify.ts       — Webhook 通知
 *   src/time.ts         — JST タイムスタンプ
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { timingSafeEqual } from 'hono/utils/buffer'
import type { Bindings } from './bindings'
import { fetchArticle } from './fetch-article'
import { generateTags, summarizeWithProvider } from './llm'
import { renderNote, sanitizeForFilename } from './note'
import { notifyWebhook } from './notify'
import { autoTagsEnabled, hostTagsFor, mergeTags } from './tags'
import { jstIso, jstStamp } from './time'
import { hostname, normalizeUrl } from './url'
import { readUrlIndex, sha1Hex, writeUrlIndexCAS } from './url-index'

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
      timingSafeEqual(token, c.env.SHARED_SECRET),
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

  const { index: urlIndex } = await readUrlIndex(c.env.VAULT, indexKey)
  if (!refresh && urlIndex[hash]) {
    // index のパスが実際に R2 上に存在する場合のみ重複とみなす。
    // Obsidian 側で Inbox から移動/削除済みなら新規保存を許可する (ADR 0010)。
    const existing = await c.env.VAULT.head(urlIndex[hash].path)
    if (existing) {
      return c.json({ ok: false, duplicate: true, path: urlIndex[hash].path })
    }
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

  // ---- 2. 要約 (Workers AI, 任意) とタグ生成 (LLM, 任意) を並列実行 ----
  // 要約とタグ生成は互いに依存しない (受け入れ条件 #35: タグ生成は手動タグ 0 件のみ判定)。
  const hostTags = hostTagsFor(url, c.env)
  const manualTags = payload.tags ?? []
  const wantSummary = c.env.ENABLE_SUMMARY === 'true' && articleMd.length > 200
  const wantTags =
    autoTagsEnabled(c.env) && manualTags.length === 0 && articleMd.length > 200

  const [summary, llmTags] = await Promise.all([
    wantSummary
      ? summarizeWithProvider(c.env, articleMd, articleTitle).catch((e) => {
          console.warn('summarize failed', (e as Error).message)
          if (c.env.NOTIFY_WEBHOOK_URL) {
            c.executionCtx.waitUntil(
              notifyWebhook(
                c.env.NOTIFY_WEBHOOK_URL,
                `[obsidian-clipper] 要約失敗: ${url} (${(e as Error).message})`,
              ),
            )
          }
          return ''
        })
      : Promise.resolve(''),
    wantTags
      ? generateTags(c.env, articleMd, articleTitle).catch((e) => {
          console.warn('auto-tag failed', (e as Error).message)
          return [] as string[]
        })
      : Promise.resolve([] as string[]),
  ])

  // ---- 2.5 タグ統合 (clipped + ユーザ + allowlist + LLM) ----
  const tags = mergeTags(['clipped', ...manualTags, ...hostTags, ...llmTags])

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

  // ---- 5. インデックス更新 (楽観ロック CAS, ADR 0010) ----
  const createdAt = jstIso(now)
  await writeUrlIndexCAS(c.env.VAULT, indexKey, (index) => {
    index[hash] = { path: key, createdAt }
  })

  return c.json({
    ok: true,
    path: key,
    bytes: new TextEncoder().encode(body).length,
    summarized: !!summary,
  })
})

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('unhandled', err)
  return c.json({ ok: false, error: err.message }, 500)
})

export default app
