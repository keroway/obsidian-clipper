/**
 * 応答本文を maxBytes までしか読まない (#222, #270)。Content-Length が上限超過なら
 * 読み始めず、無ければストリームを逐次カウントして超過時点で cancel する。
 * 上限超過は null で返す (throw すると呼び出し側のリトライ/フォールバック経路に
 * 乗ってしまうため、呼び出し側が意味を決める)。
 */
export async function readTextWithLimit(
  res: Response,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
