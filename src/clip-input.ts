// POST /clip の入力種別判別 (ADR 0011)。
// Content-Type / JSON ボディの内容だけで種別を決める純関数群。workerd 起動なしでテストできる。

export type UrlClipBody = {
  url: string
  title?: string
  selection?: string
  note?: string
  tags?: string[]
}

export type TextClipBody = {
  markdown?: string
  text?: string
  title?: string
  note?: string
  tags?: string[]
}

export type ClassifiedJsonBody =
  | { kind: 'url'; body: UrlClipBody }
  | { kind: 'text'; body: TextClipBody }

// Content-Type ヘッダから multipart か json かを判定する。
// multipart/form-data はブラウザ/curl が boundary をパラメータとして付与するので前方一致で判定する。
export function detectContentKind(
  contentType: string | undefined,
): 'multipart' | 'json' {
  if (contentType?.toLowerCase().startsWith('multipart/form-data')) {
    return 'multipart'
  }
  return 'json'
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

// パース済み JSON ボディを url クリップ / テキストクリップに分類する。
// どちらにも該当しなければ null (呼び出し側で 400 にする)。
export function classifyJsonBody(body: unknown): ClassifiedJsonBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (isNonEmptyString(b.url)) {
    return { kind: 'url', body: b as unknown as UrlClipBody }
  }
  if (isNonEmptyString(b.markdown) || isNonEmptyString(b.text)) {
    return { kind: 'text', body: b as unknown as TextClipBody }
  }
  return null
}
