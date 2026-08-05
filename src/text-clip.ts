// テキスト/Markdown クリップ (ADR 0011) の本文生成 + R2 書き込み。
// URL が無いため要約・自動タグ・ホストタグ・URL 重複検知の対象外。

import type { Bindings } from './bindings'
import { isNonEmptyString, type TextClipBody } from './clip-input'
import { renderNote, sanitizeForFilename } from './note'
import { mergeTags } from './tags'
import { jstIso, jstStamp } from './time'

export type TextClipResult = {
  path: string
  bytes: number
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
