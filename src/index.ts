/**
 * obsidian-clipper
 *
 * URL / Markdown・テキスト / 画像 を受け取って、frontmatter 付き Markdown
 * (または画像バイナリ) として R2 (= Remotely Save の Vault バケット) に
 * PUT する Cloudflare Worker。POST /clip 単一エンドポイントを Content-Type
 * とボディ内容で分岐する (ADR 0011)。
 *
 * URL クリップの場合:
 *   1. URL を正規化 (トラッキングパラメータ除去)
 *   2. Jina Reader (https://r.jina.ai/) で本文 Markdown を取得
 *   3. (任意) Workers AI で要約
 *   4. frontmatter 付き Markdown を生成
 *   5. Inbox/ に PUT
 *
 * ルータ本体は Hono ルーティングと POST /clip の入力種別分岐・委譲のみに絞っている。
 * ロジックは責務ごとに以下へ分割している:
 *   src/bindings.ts     — Bindings 型
 *   src/url.ts          — normalizeUrl / hostname
 *   src/fetch-article.ts — Jina Reader 取得 + Browser Rendering フォールバック
 *   src/llm.ts          — 要約・タグ生成 (Workers AI / Anthropic)
 *   src/tags.ts         — タグ正規化・統合・ホスト名 allowlist
 *   src/note.ts         — renderNote / ファイル名サニタイズ
 *   src/url-index.ts    — URL/画像 重複検知インデックス
 *   src/notify.ts       — Webhook 通知
 *   src/time.ts         — JST タイムスタンプ
 *   src/clip-input.ts   — POST /clip の入力種別判別 (ADR 0011)
 *   src/attachment.ts   — 画像添付の MIME/サイズ検証 (ADR 0011)
 *   src/text-clip.ts    — テキスト/Markdown クリップの本文生成 + R2 書き込み (ADR 0011)
 *   src/image-clip.ts   — 画像クリップの multipart パース・重複検知・R2 書き込み・埋め込みノート生成 (ADR 0011)
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { timingSafeEqual } from 'hono/utils/buffer'
import type { Bindings } from './bindings'
import {
  classifyJsonBody,
  detectContentKind,
  type TextClipBody,
  type UrlClipBody,
} from './clip-input'
import { fetchArticle } from './fetch-article'
import { saveImageClip } from './image-clip'
import { generateTags, summarizeWithProvider } from './llm'
import { renderNote, sanitizeForFilename } from './note'
import { notifyWebhook } from './notify'
import { autoTagsEnabled, hostTagsFor, mergeTags } from './tags'
import { saveTextClip } from './text-clip'
import { jstIso, jstStamp } from './time'
import { hostname, normalizeUrl } from './url'
import { readUrlIndex, sha1Hex, writeUrlIndexCAS } from './url-index'

type AppContext = Context<{ Bindings: Bindings }>

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) =>
  c.text(
    [
      'obsidian-clipper',
      '',
      'POST /clip',
      '  Authorization: Bearer <SHARED_SECRET>',
      '',
      '  URL クリップ (Content-Type: application/json):',
      '    Body: { "url": string, "title"?: string, "selection"?: string, "note"?: string, "tags"?: string[] }',
      '',
      '  テキスト/Markdown クリップ (Content-Type: application/json):',
      '    Body: { "markdown"?: string, "text"?: string, "title"?: string, "note"?: string, "tags"?: string[] }',
      '    (markdown か text のいずれかが必須)',
      '',
      '  画像クリップ (Content-Type: multipart/form-data):',
      '    Fields: image=<file>, title?, note?, tags? (comma区切り), embed? ("1" で埋め込みノートも生成)',
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
  if (detectContentKind(c.req.header('content-type')) === 'multipart') {
    return handleImageClip(c)
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' })
  }
  const classified = classifyJsonBody(payload)
  if (!classified) {
    throw new HTTPException(400, {
      message: 'url, or markdown/text is required',
    })
  }
  if (classified.droppedTags) {
    // 正規化して処理は続けるが、黙って捨てると送信側は気づけない (#75)。
    // 以前は文字列の tags が 1 文字ずつのタグとして frontmatter に書かれており、
    // エラーも警告も出なかった。
    console.warn('clip: tags に不正な値が含まれていたため無視しました')
  }
  return classified.kind === 'url'
    ? handleUrlClip(c, classified.body)
    : handleTextClip(c, classified.body)
})

app.onError((err, c) => {
  // HTTPException をそのまま返すと **本文がプレーンテキスト**になり、
  // README が API 契約として明記している `{ ok: false, error: ... }` と
  // 食い違う（#77 で 413 のテストを書いていて発覚）。
  //
  // クライアントは成功時に JSON を読むので、エラー時だけ形が変わると
  // パースに失敗して「原因不明の失敗」になる。500 だけが JSON という
  // 非対称も紛らわしい。全経路を JSON に揃える。
  if (err instanceof HTTPException) {
    return c.json({ ok: false, error: err.message }, err.status)
  }
  console.error('unhandled', err)
  return c.json({ ok: false, error: err.message }, 500)
})

export default app

// ---- URL クリップ (既存フロー、挙動不変) ----
async function handleUrlClip(c: AppContext, payload: UrlClipBody) {
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
          // 要約・本文取得と同じく webhook へも通知する。ここだけ
          // console.warn 止まりだと、LLM 障害でタグが付かなくなっても
          // Cloudflare のログを能動的に見ない限り気づけない（#70）。
          // ADR 0006 の「失敗を無音にしない」意図が、後発の ADR 0008 で
          // 追加されたタグ生成パスに反映されていなかった。
          if (c.env.NOTIFY_WEBHOOK_URL) {
            c.executionCtx.waitUntil(
              notifyWebhook(
                c.env.NOTIFY_WEBHOOK_URL,
                `[obsidian-clipper] タグ生成失敗: ${url} (${(e as Error).message})`,
              ),
            )
          }
          return [] as string[]
        })
      : Promise.resolve([] as string[]),
  ])

  // ---- 2.5 タグ統合 (clipped + allowlist + ユーザ + LLM) ----
  // hostTags (ホスト名 allowlist) をユーザ指定タグより先に詰める。合計上限 8 件
  // (MAX_AUTO_TAGS_TOTAL, #104) に達すると後続は無音で切り捨てられるため、
  // 手動タグを多く渡してもホスト allowlist タグが消えないようにする。
  const tags = mergeTags(['clipped', ...hostTags, ...manualTags, ...llmTags])

  // ---- 3. 保存パス決定 ----
  const now = new Date()
  const stamp = jstStamp(now)
  const slug =
    sanitizeForFilename(articleTitle || hostname(url) || 'clip').slice(0, 60) ||
    'clip'
  const uniq = crypto.randomUUID().slice(0, 8)
  const filename = `${stamp}_${slug}_${uniq}.md`
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
  const indexWritten = await writeUrlIndexCAS(
    c.env.VAULT,
    indexKey,
    (index) => {
      index[hash] = { path: key, createdAt }
    },
  )
  if (!indexWritten && c.env.NOTIFY_WEBHOOK_URL) {
    c.executionCtx.waitUntil(
      notifyWebhook(
        c.env.NOTIFY_WEBHOOK_URL,
        `[obsidian-clipper] urls.json が壊れているため重複検知インデックスの更新をスキップしました: ${key}`,
      ),
    )
  }

  return c.json({
    ok: true,
    path: key,
    bytes: new TextEncoder().encode(body).length,
    summarized: !!summary,
    tags,
  })
}

// ---- テキスト/Markdown クリップ (ADR 0011) ----
// URL が無いため要約・自動タグ・ホストタグ・URL 重複検知の対象外。
// 本文生成 + R2 書き込みは src/text-clip.ts に委譲する。
async function handleTextClip(c: AppContext, payload: TextClipBody) {
  const result = await saveTextClip(c.env, payload)
  return c.json({ ok: true, ...result })
}

// ---- 画像クリップ (multipart/form-data, ADR 0011) ----
// multipart パース・重複検知・R2 書き込み・インデックス更新・埋め込みノート生成は
// src/image-clip.ts に委譲する。ここでは formData 取得とレスポンス整形のみ行う。
async function handleImageClip(c: AppContext) {
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    throw new HTTPException(400, { message: 'invalid multipart body' })
  }

  const refresh = c.req.query('refresh') === '1'
  const result = await saveImageClip(c.env, form, refresh, (p) =>
    c.executionCtx.waitUntil(p),
  )

  if (result.duplicate) {
    return c.json({
      ok: false,
      duplicate: true,
      path: result.path,
      embedded: result.embedded,
      ...(result.notePath ? { notePath: result.notePath } : {}),
    })
  }
  const { path, bytes, embedded, notePath } = result
  return c.json({
    ok: true,
    path,
    bytes,
    embedded,
    ...(notePath ? { notePath } : {}),
  })
}
