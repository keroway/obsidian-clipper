// エラー詳細に含める最大文字数と、そのために読む最大バイト数 (#225)。
// UTF-8 は 1 文字最大 4 バイトなので、文字数上限の 4 倍を読めば足りる。
export const ERROR_DETAIL_MAX_CHARS = 200
const ERROR_DETAIL_MAX_BYTES = ERROR_DETAIL_MAX_CHARS * 4

/**
 * 非2xx応答の本文先頭を最大 ERROR_DETAIL_MAX_CHARS 文字だけ返す。
 * res.text() と違い、必要なバイト数を読んだ時点でストリームを cancel するため、
 * 巨大なエラー本文でもメモリへ全量を載せない。読み取り失敗は空文字。
 */
export async function readErrorSnippet(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (received < ERROR_DETAIL_MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch {
    return ''
  } finally {
    await reader.cancel().catch(() => {})
  }
  return text.slice(0, ERROR_DETAIL_MAX_CHARS)
}
