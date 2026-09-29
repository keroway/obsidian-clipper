import type { Bindings } from './bindings'
import { DEFAULT_MAX_TEXT_CLIP_BYTES } from './text-clip'
import { hostname } from './url'

export type FetchedArticle = {
  md: string
  title?: string
  via?: 'jina' | 'jina-retry' | 'browser-rendering'
  err?: string
}

// 1 リクエストごとのタイムアウト / リトライ設定 (個人ツール想定で定数)
const JINA_TIMEOUT_MS = 20_000
const BROWSER_RENDERING_TIMEOUT_MS = 30_000
const JINA_MAX_RETRIES = 2
const JINA_RETRY_STATUS = new Set([429, 503])

function extractJinaTitle(md: string): string | undefined {
  const m = md.match(/^Title:\s*(.+)$/m)
  return m ? m[1].trim() : undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const bodyTooLargeMessage = (maxBytes: number) =>
  `article body too large (> ${maxBytes} bytes)`

/**
 * 応答本文を maxBytes までしか読まない (#222)。Content-Length が上限超過なら
 * 読み始めず、無ければストリームを逐次カウントして超過時点で cancel する。
 * 上限超過は null で返す (throw すると呼び出し側のリトライ/フォールバック経路に
 * 乗ってしまうため)。
 */
async function readTextWithLimit(
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

/**
 * 本文取得。Jina Reader を指数バックオフでリトライ (429/503 のみ) し、
 * 最終的に失敗したら Browser Rendering の /markdown にフォールバックする。
 * すべて失敗しても throw せず { md: '', err } を返す (失敗時 200 の不変条件)。
 *
 * フォールバックは ADR 0007 の定義どおり「Jina が 429/503 (または fetch 例外)
 * で最終的に失敗したとき」だけ発火する。404 等の非リトライ対象ステータスで
 * break した場合はフォールバックしない (#110)。
 *
 * 応答本文は maxBytes (既定 MAX_TEXT_CLIP_BYTES 相当) を超えた時点で読み取りを
 * 打ち切り、{ md: '', err: 'article body too large ...' } を返す (#222)。
 * 上限超過はリトライもフォールバックもしない (別経路でも同じ本文が返るため)。
 */
export async function fetchArticle(
  url: string,
  env: Bindings,
  maxBytes: number = DEFAULT_MAX_TEXT_CLIP_BYTES,
): Promise<FetchedArticle> {
  let lastErr: string | undefined
  let retryableFailure = false
  for (let attempt = 0; attempt <= JINA_MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = { Accept: 'text/plain' }
      if (env.JINA_API_KEY) {
        headers.Authorization = `Bearer ${env.JINA_API_KEY}`
      }
      const { res, clear } = await fetchWithTimeout(
        `https://r.jina.ai/${url}`,
        { headers, cf: { cacheTtl: 0 } },
        JINA_TIMEOUT_MS,
      )
      try {
        if (res.ok) {
          const md = await readTextWithLimit(res, maxBytes)
          if (md === null) {
            lastErr = bodyTooLargeMessage(maxBytes)
            retryableFailure = false
            break
          }
          if (md.trim() === '') {
            // 空本文の 200 は成功扱いにしない (#149): 失敗説明・通知経路に
            // 接続するため err を設定して抜ける。429/503 ではないので
            // retryableFailure は立てず、Browser Rendering フォールバックは
            // 発火させない (ADR 0007 の対象条件外)。前試行の503リトライで
            // retryableFailure が立っていた場合も、最終結果が空本文なら
            // 解除する (#153: 試行間の状態持ち越しでフォールバックが誤発火する)。
            lastErr = 'jina empty body'
            retryableFailure = false
            break
          }
          return {
            md,
            title: extractJinaTitle(md),
            via: attempt === 0 ? 'jina' : 'jina-retry',
          }
        }
        lastErr = `jina ${res.status}`
        // リトライ対象ステータスかつ残り回数があるときだけ待って再試行
        if (JINA_RETRY_STATUS.has(res.status)) {
          retryableFailure = true
          if (attempt < JINA_MAX_RETRIES) {
            const wait = retryDelayMs(res, attempt)
            await sleep(wait)
            continue
          }
        } else {
          retryableFailure = false
        }
        break
      } finally {
        clear()
      }
    } catch (e) {
      lastErr = `jina ${(e as Error).message}`
      retryableFailure = true
      if (attempt < JINA_MAX_RETRIES) {
        await sleep(retryDelayMs(null, attempt))
        continue
      }
      break
    }
  }

  // ---- Browser Rendering フォールバック (429/503 の最終失敗時のみ) ----
  // 受け入れ条件 (#34): フォールバックの成否は console.log で残す。
  if (
    retryableFailure &&
    env.CF_ACCOUNT_ID &&
    env.BROWSER_RENDERING_API_TOKEN
  ) {
    // ログには URL 全体を出さない (パス/クエリに利用者固有の値が入りうる, #224)。
    const host = hostname(url)
    console.log(
      `fetch fallback: trying browser-rendering for ${host} (jina: ${lastErr ?? 'failed'})`,
    )
    try {
      const md = await fetchViaBrowserRendering(url, env, maxBytes)
      if (md === null) {
        lastErr = `${lastErr ?? 'jina failed'}; browser-rendering ${bodyTooLargeMessage(maxBytes)}`
        console.log(`fetch fallback: browser-rendering too large for ${host}`)
      } else if (md) {
        console.log(`fetch fallback: browser-rendering succeeded for ${host}`)
        return { md, title: extractJinaTitle(md), via: 'browser-rendering' }
      } else {
        lastErr = `${lastErr ?? 'jina failed'}; browser-rendering empty`
        console.log(`fetch fallback: browser-rendering empty for ${host}`)
      }
    } catch (e) {
      lastErr = `${lastErr ?? 'jina failed'}; browser-rendering ${(e as Error).message}`
      console.log(
        `fetch fallback: browser-rendering failed for ${host} (${(e as Error).message})`,
      )
    }
  }

  return { md: '', err: lastErr ?? 'fetch failed' }
}

// Retry-After (秒) を尊重しつつ、無ければ指数バックオフ (0.5s, 1s, ...)
function retryDelayMs(res: Response | null, attempt: number): number {
  if (res) {
    const ra = res.headers.get('retry-after')
    if (ra) {
      const sec = Number(ra)
      if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 10_000)
    }
  }
  return 500 * 2 ** attempt
}

// レスポンス本文の読み取り (res.text() / res.json()) は呼び出し側が行うため、
// abort タイマーはヘッダー受信後も維持する。呼び出し側は本文読み取り完了後に
// 必ず `clear()` を呼ぶこと (#141: 本文読み取り中の停止に対して abort させる)。
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; clear: () => void }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(input, { ...init, signal: controller.signal })
    return { res, clear: () => clearTimeout(timer) }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

async function fetchViaBrowserRendering(
  url: string,
  env: Bindings,
  maxBytes: number,
): Promise<string | null> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`
  const { res, clear } = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.BROWSER_RENDERING_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url }),
    },
    BROWSER_RENDERING_TIMEOUT_MS,
  )
  try {
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    // REST API は { success, result } を返す。result が文字列 (markdown) 想定。
    // JSON エンベロープ分を含む生バイト数で上限判定する (#222)。
    const raw = await readTextWithLimit(res, maxBytes)
    if (raw === null) return null
    const data = JSON.parse(raw) as {
      success?: boolean
      result?: string | { markdown?: string }
      errors?: unknown
    }
    if (typeof data.result === 'string') return data.result.trim()
    if (data.result && typeof data.result.markdown === 'string') {
      return data.result.markdown.trim()
    }
    return ''
  } finally {
    clear()
  }
}
