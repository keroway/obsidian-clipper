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
// JSON 文字列は \uXXXX エスケープで 1 バイトが最大 6 バイトに膨らむ (ASCII 1 バイト →
// 6 バイト)。同一内容が表記だけで 413 にならないよう、エスケープ分を含めて見積もる (#337)。
// 解析後の各フィールドは別途 UTF-8 バイト数で上限を適用する。
const JSON_ESCAPE_EXPANSION = 6

export function jsonBodyLimit(maxFieldBytes: number): number {
  return (
    JSON_BODY_FIELD_COUNT * maxFieldBytes * JSON_ESCAPE_EXPANSION +
    JSON_BODY_OVERHEAD_BYTES
  )
}

function tooLarge(): HTTPException {
  return new HTTPException(413, { message: 'request body too large' })
}

// 上限超過は確定済みなので、cancel の失敗 (reject) で 413 を上書きしない (#289)。
// cancel の完了も待たない (pending のままでも 413 を返せるように, #291)。
function cancelQuietly(
  target: { cancel(): Promise<void> } | null | undefined,
): void {
  try {
    void target?.cancel().catch(() => {})
  } catch {
    // 413 を優先するため握り潰す
  }
}

// Content-Length があれば読み取り前に弾き、無い/偽装されている場合も
// ストリームの読み取り中に累積バイト数で打ち切る。
// multipart 経路 (#239) でも同じ上限付き読み取りを使うため export している。
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelQuietly(req.body)
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
        cancelQuietly(reader)
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
  return merged
}

// 対になっていない上位/下位サロゲート。JSON の "\ud800" エスケープは正常な UTF-8
// のまま通過するが、保存時の UTF-8 化で U+FFFD に化けるため弾く (#323)。
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function rejectLoneSurrogate(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && LONE_SURROGATE_RE.test(value)) {
    throw new Error('lone surrogate')
  }
  return value
}

export async function readJsonWithLimit(
  req: Request,
  maxBytes: number,
): Promise<unknown> {
  const merged = await readBodyWithLimit(req, maxBytes)
  try {
    // fatal: 不正な UTF-8 を U+FFFD に置換せず例外にする (#309)
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
    return JSON.parse(decoder.decode(merged), rejectLoneSurrogate)
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' })
  }
}
