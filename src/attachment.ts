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
  if (fromName === 'jpeg') return 'jpg'
  if (fromName && Object.values(IMAGE_EXT).includes(fromName)) {
    return fromName
  }
  return null
}

// 申告 MIME/拡張子だけでなく実バイト列(マジックナンバー)も検証する。
// ADR 0011 は SVG を XSS 懸念で対象外としているが、申告 MIME を偽装すれば
// 実体が SVG (や任意バイト列) でも通ってしまうため、拡張子ごとに実体を照合する。
const MAGIC_BYTES_MATCHERS: Record<string, (bytes: Uint8Array) => boolean> = {
  png: (b) =>
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) =>
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61,
  webp: (b) =>
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50,
}

// extForMime が決めた拡張子と実バイト列が一致するか検証する。
// 未知の拡張子は呼び出し側の extForMime で既に弾かれている前提。
export function matchesImageMagicBytes(
  ext: string,
  bytes: ArrayBufferLike,
): boolean {
  const matcher = MAGIC_BYTES_MATCHERS[ext]
  return matcher ? matcher(new Uint8Array(bytes)) : false
}

export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MiB

export function resolveMaxImageBytes(raw: string | undefined): number {
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMAGE_BYTES
}
