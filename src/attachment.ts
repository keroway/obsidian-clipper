// 画像添付の MIME/サイズ検証・R2 キー組み立て・書き込み (ADR 0011)。

// v1 で許可する画像 MIME。SVG は XSS 懸念があるため対象外。
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const EXT_BY_FILENAME_RE = /\.([a-z0-9]+)$/i

// MIME から保存拡張子を決める。MIME が未知/空ならファイル名の拡張子にフォールバックする。
// どちらでも判定できなければ null (呼び出し側で 415 にする)。
export function extForMime(mime: string, filename?: string): string | null {
  const normalized = mime?.toLowerCase().split(';')[0]?.trim()
  if (normalized && IMAGE_EXT[normalized]) return IMAGE_EXT[normalized]
  const m = filename?.match(EXT_BY_FILENAME_RE)
  const fromName = m?.[1]?.toLowerCase()
  if (fromName && Object.values(IMAGE_EXT).includes(fromName)) {
    return fromName === 'jpeg' ? 'jpg' : fromName
  }
  return null
}

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MiB

export function resolveMaxImageBytes(raw: string | undefined): number {
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMAGE_BYTES
}
