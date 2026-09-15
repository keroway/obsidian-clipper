// テキスト/Markdown クリップ (ADR 0011) の本文生成 + R2 書き込み。
// URL が無いため要約・自動タグ・ホストタグ・URL 重複検知の対象外。

import { HTTPException } from 'hono/http-exception'
import type { Bindings } from './bindings'
import { isNonEmptyString, type TextClipBody } from './clip-input'
import { renderNote, sanitizeForFilename } from './note'
import { mergeTags } from './tags'
import { jstIso, jstStamp } from './time'

export type TextClipResult = {
  path: string
  bytes: number
}

// 画像クリップの MAX_IMAGE_BYTES (src/attachment.ts) に相当するサイズ上限 (#176)。
export const DEFAULT_MAX_TEXT_CLIP_BYTES = 1 * 1024 * 1024 // 1 MiB

export function resolveMaxTextClipBytes(raw: string | undefined): number {
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TEXT_CLIP_BYTES
}

export async function saveTextClip(
  env: Bindings,
  payload: TextClipBody,
): Promise<TextClipResult> {
  const bodyText = isNonEmptyString(payload.markdown)
    ? payload.markdown
    : isNonEmptyString(payload.text)
      ? payload.text
      : ''

  const maxBytes = resolveMaxTextClipBytes(env.MAX_TEXT_CLIP_BYTES)
  if (new TextEncoder().encode(bodyText).length > maxBytes) {
    throw new HTTPException(413, { message: 'text clip too large' })
  }

  const folder = (env.INBOX_FOLDER || 'Inbox').replace(/^\/+|\/+$/g, '')
  const prefix = (env.VAULT_PREFIX || '').replace(/^\/+/, '')

  const manualTags = payload.tags ?? []
  const tags = mergeTags(['clipped', ...manualTags])

  const now = new Date()
  const stamp = jstStamp(now)
  const firstLine = bodyText.split('\n').find((l) => l.trim().length > 0)
  const slug =
    sanitizeForFilename(
      payload.title || firstLine || payload.note || 'note',
    ).slice(0, 60) || 'note'
  const uniq = crypto.randomUUID().slice(0, 8)
  const filename = `${stamp}_${slug}_${uniq}.md`
  const key = `${prefix}${folder}/${filename}`

  const body = renderNote({
    source: 'text-clip',
    title: payload.title,
    note: payload.note,
    tags,
    body: bodyText,
    createdIso: jstIso(now),
  })

  await env.VAULT.put(key, body, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    customMetadata: { source: 'obsidian-clipper', kind: 'text' },
  })

  return { path: key, bytes: new TextEncoder().encode(body).length }
}
