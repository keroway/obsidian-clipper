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
  if (Number.isFinite(n) && n > 0) return n
  if (raw) {
    console.warn(
      `MAX_TEXT_CLIP_BYTES is invalid (${JSON.stringify(raw)}); falling back to default ${DEFAULT_MAX_TEXT_CLIP_BYTES}`,
    )
  }
  return DEFAULT_MAX_TEXT_CLIP_BYTES
}

// title/note/selection はクライアント制御可能な任意長の文字列で、本文と同じく
// renderNote() 経由でそのまま R2 に書き込まれる (#178)。本文と同じ上限を
// 個別に適用し、超過時は 413 で明示的に弾く。
export function assertFieldWithinLimit(
  value: string | undefined,
  maxBytes: number,
  fieldName: string,
): void {
  if (
    value !== undefined &&
    new TextEncoder().encode(value).length > maxBytes
  ) {
    throw new HTTPException(413, { message: `${fieldName} too large` })
  }
}

// tags 配列 (JSON 経路: URL クリップ・テキストクリップ) は要素単体の長さ上限
// (#180/#181) しか無く、配列全体のサイズには上限が無かった (#183)。画像クリップの
// tagsField (multipart のカンマ区切り文字列) は assertFieldWithinLimit で保護済み
// なので、JSON 経路も要素の合計バイト数で同じ上限を適用して揃える。
export function assertTagsWithinLimit(
  tags: string[] | undefined,
  maxBytes: number,
): void {
  if (!tags || tags.length === 0) return
  const totalBytes = tags.reduce(
    (sum, tag) => sum + new TextEncoder().encode(tag).length,
    0,
  )
  if (totalBytes > maxBytes) {
    throw new HTTPException(413, { message: 'tags too large' })
  }
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
  assertFieldWithinLimit(payload.title, maxBytes, 'title')
  assertFieldWithinLimit(payload.note, maxBytes, 'note')
  assertTagsWithinLimit(payload.tags, maxBytes)

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
