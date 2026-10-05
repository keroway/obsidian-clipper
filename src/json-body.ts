// POST /clip の JSON 経路でリクエストボディを上限付きで読み取る (#237)。
// c.req.json() は全量をメモリに載せて解析するため、保存されない巨大な
// 未使用フィールドや空要素の巨大配列も受理してしまっていた。

import { HTTPException } from 'hono/http-exception'

// JSON ボディに同梱できる有効フィールド数 (url / markdown or text / title /
// note / selection / tags)。各フィールドは MAX_TEXT_CLIP_BYTES が個別に上限なので、
// 総量の上限は「フィールド数 × 上限 + 定数マージン」で決める (画像経路の
// precheckLimit, #215 と同じ考え方)。
const JSON_BODY_FIELD_COUNT = 6
const JSON_BODY_OVERHEAD_BYTES = 64 * 1024

export function jsonBodyLimit(maxFieldBytes: number): number {
  return JSON_BODY_FIELD_COUNT * maxFieldBytes + JSON_BODY_OVERHEAD_BYTES
}

function tooLarge(): HTTPException {
  return new HTTPException(413, { message: 'request body too large' })
}

// Content-Length があれば読み取り前に弾き、無い/偽装されている場合も
// ストリームの読み取り中に累積バイト数で打ち切る。
export async function readJsonWithLimit(
  req: Request,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel()
    throw tooLarge()
  }

  const chunks: Uint8Array[] = []
  let total = 0
  if (req.body) {
    const reader = req.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged))
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' })
  }
}
