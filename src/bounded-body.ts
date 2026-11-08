/**
 * 応答本文を maxBytes までしか読まない (#222, #270)。Content-Length が上限超過なら
 * 読み始めず、無ければストリームを逐次カウントして超過時点で cancel する。
 * 上限超過は null で返す (throw すると呼び出し側のリトライ/フォールバック経路に
 * 乗ってしまうため、呼び出し側が意味を決める)。
 */
export class InvalidUtf8Error extends Error {
  constructor() {
    super('invalid UTF-8 in body')
    this.name = 'InvalidUtf8Error'
  }
}

/**
 * 読まない応答本文の cancel を開始する。結果は待たず、拒否・同期例外も握り潰す。
 * cancel が未解決のままでも呼び出し側の処理を止めない (#391)。
 */
export function releaseBody(res: Response): void {
  try {
    res.body?.cancel().catch(() => {})
  } catch {
    // 解放はベストエフォート
  }
}

/**
 * `strictUtf8: true` のときは不正 UTF-8 を U+FFFD に置換せず InvalidUtf8Error を
 * throw する (#345)。既定は従来どおり置換。
 */
export async function readTextWithLimit(
  res: Response,
  maxBytes: number,
  options: { strictUtf8?: boolean } = {},
): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    // 上限超過は確定済み。cancel の完了を待つと pending のストリームで停止する (#291)
    void res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8', {
    fatal: options.strictUtf8 === true,
    ignoreBOM: false,
  })
  let received = 0
  let text = ''
  // 不正 UTF-8 への変換は decoder の例外だけに限定する。reader.read() 由来の
  // TypeError (ストリーム失敗) は元のまま伝播させ、呼び出し側のリトライを妨げない (#381)。
  const decode = (chunk?: Uint8Array, stream = false): string => {
    try {
      return chunk ? decoder.decode(chunk, { stream }) : decoder.decode()
    } catch (e) {
      if (e instanceof TypeError && options.strictUtf8) {
        void reader.cancel().catch(() => {})
        throw new InvalidUtf8Error()
      }
      throw e
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      void reader.cancel().catch(() => {})
      return null
    }
    text += decode(value, true)
  }
  return text + decode()
}
