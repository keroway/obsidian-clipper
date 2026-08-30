// 画像クリップ (multipart/form-data, ADR 0011) の
// multipart パース + 重複検知 + R2 書き込み + インデックス更新 (CAS) + 埋め込みノート生成。

import { HTTPException } from 'hono/http-exception'
import {
  extForMime,
  matchesImageMagicBytes,
  resolveMaxImageBytes,
} from './attachment'
import type { Bindings } from './bindings'
import { renderNote, sanitizeForFilename } from './note'
import { notifyWebhook } from './notify'
import { mergeTags } from './tags'
import { jstIso, jstStamp } from './time'
import { readUrlIndex, sha1HexBytes, writeUrlIndexCAS } from './url-index'

export type ImageClipResult =
  | { duplicate: true; path: string; embedded: boolean; notePath?: string }
  | {
      duplicate: false
      path: string
      bytes: number
      embedded: boolean
      notePath?: string
    }

// workers-types の FormData#get() は string | null 固定で File を表現できないため、
// 実行時に string でないことを確認した上で File として扱う。
function parseImageFile(form: FormData): File {
  const rawImage = form.get('image')
  if (!rawImage || typeof rawImage === 'string') {
    throw new HTTPException(400, { message: 'image file is required' })
  }
  return rawImage as unknown as File
}

export async function saveImageClip(
  env: Bindings,
  form: FormData,
  refresh: boolean,
): Promise<ImageClipResult> {
  const file = parseImageFile(form)

  const ext = extForMime(file.type, file.name)
  if (!ext) {
    throw new HTTPException(415, { message: 'unsupported image type' })
  }

  const maxBytes = resolveMaxImageBytes(env.MAX_IMAGE_BYTES)
  if (file.size > maxBytes) {
    throw new HTTPException(413, { message: 'image too large' })
  }

  const buf = await file.arrayBuffer()
  if (!matchesImageMagicBytes(ext, buf)) {
    throw new HTTPException(415, { message: 'unsupported image type' })
  }

  const folder = (env.INBOX_FOLDER || 'Inbox').replace(/^\/+|\/+$/g, '')
  const attachmentsFolder = (env.ATTACHMENTS_FOLDER || 'Attachments').replace(
    /^\/+|\/+$/g,
    '',
  )
  const prefix = (env.VAULT_PREFIX || '').replace(/^\/+/, '')
  const indexKey = `${prefix}${folder}/.index/urls.json`

  const hash = await sha1HexBytes(buf)

  // ---- 任意: 埋め込みノートの生成 (embed=1 または title/note/tags 指定時) ----
  const embedField = form.get('embed')
  const title = form.get('title')
  const note = form.get('note')
  const tagsField = form.get('tags')
  const wantEmbed =
    embedField === '1' ||
    typeof title === 'string' ||
    typeof note === 'string' ||
    typeof tagsField === 'string'

  const buildEmbedNote = async (
    now: Date,
    embedTarget: string,
  ): Promise<string> => {
    const stamp = jstStamp(now)
    const origName = file.name?.replace(/\.[a-zA-Z0-9]+$/, '') ?? ''
    const slug = sanitizeForFilename(origName).slice(0, 60) || 'image'
    const uniq = crypto.randomUUID().slice(0, 8)
    const manualTags =
      typeof tagsField === 'string'
        ? tagsField
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : []
    const tags = mergeTags(['clipped', ...manualTags])
    const noteBody = renderNote({
      source: 'image-clip',
      title: typeof title === 'string' ? title : undefined,
      note: typeof note === 'string' ? note : undefined,
      tags,
      body: `![[${embedTarget}]]`,
      createdIso: jstIso(now),
    })
    const noteFilename = `${stamp}_${slug}_${uniq}.md`
    const notePath = `${prefix}${folder}/${noteFilename}`
    await env.VAULT.put(notePath, noteBody, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { source: 'obsidian-clipper', kind: 'image-note' },
    })
    return notePath
  }

  const { index: urlIndex } = await readUrlIndex(env.VAULT, indexKey)
  if (!refresh && urlIndex[hash]) {
    const existingPath = urlIndex[hash].path
    const existing = await env.VAULT.head(existingPath)
    if (existing) {
      if (!wantEmbed) {
        return { duplicate: true, path: existingPath, embedded: false }
      }
      const embedTarget = existingPath.startsWith(prefix)
        ? existingPath.slice(prefix.length)
        : existingPath
      const notePath = await buildEmbedNote(new Date(), embedTarget)
      return { duplicate: true, path: existingPath, embedded: true, notePath }
    }
  }

  const now = new Date()
  const stamp = jstStamp(now)
  const origName = file.name?.replace(/\.[a-zA-Z0-9]+$/, '') ?? ''
  const slug = sanitizeForFilename(origName).slice(0, 60) || 'image'
  const uniq = crypto.randomUUID().slice(0, 8)
  const filename = `${stamp}_${slug}_${uniq}.${ext}`
  const key = `${prefix}${attachmentsFolder}/${filename}`

  await env.VAULT.put(key, buf, {
    httpMetadata: { contentType: file.type || `image/${ext}` },
    customMetadata: { source: 'obsidian-clipper', kind: 'image' },
  })

  const createdAt = jstIso(now)
  const indexWritten = await writeUrlIndexCAS(env.VAULT, indexKey, (index) => {
    index[hash] = { path: key, createdAt }
  })
  if (!indexWritten && env.NOTIFY_WEBHOOK_URL) {
    await notifyWebhook(
      env.NOTIFY_WEBHOOK_URL,
      `[obsidian-clipper] urls.json が壊れているため重複検知インデックスの更新をスキップしました: ${key}`,
    )
  }

  const notePath = wantEmbed
    ? await buildEmbedNote(now, `${attachmentsFolder}/${filename}`)
    : undefined

  return {
    duplicate: false,
    path: key,
    bytes: buf.byteLength,
    embedded: !!notePath,
    ...(notePath ? { notePath } : {}),
  }
}
