import type { Bindings } from './bindings'

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

/**
 * 本文取得。Jina Reader を指数バックオフでリトライ (429/503 のみ) し、
 * 最終的に失敗したら Browser Rendering の /markdown にフォールバックする。
 * すべて失敗しても throw せず { md: '', err } を返す (失敗時 200 の不変条件)。
 */
export async function fetchArticle(
  url: string,
  env: Bindings,
): Promise<FetchedArticle> {
  let lastErr: string | undefined
  for (let attempt = 0; attempt <= JINA_MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = { Accept: 'text/plain' }
      if (env.JINA_API_KEY) {
        headers.Authorization = `Bearer ${env.JINA_API_KEY}`
      }
      const res = await fetchWithTimeout(
        `https://r.jina.ai/${url}`,
        { headers, cf: { cacheTtl: 0 } },
        JINA_TIMEOUT_MS,
      )
      if (res.ok) {
        const md = await res.text()
        return {
          md,
          title: extractJinaTitle(md),
          via: attempt === 0 ? 'jina' : 'jina-retry',
        }
      }
      lastErr = `jina ${res.status}`
      // リトライ対象ステータスかつ残り回数があるときだけ待って再試行
      if (JINA_RETRY_STATUS.has(res.status) && attempt < JINA_MAX_RETRIES) {
        const wait = retryDelayMs(res, attempt)
        await sleep(wait)
        continue
      }
      break
    } catch (e) {
      lastErr = `jina ${(e as Error).message}`
      if (attempt < JINA_MAX_RETRIES) {
        await sleep(retryDelayMs(null, attempt))
        continue
      }
      break
    }
  }

  // ---- Browser Rendering フォールバック (設定済みの場合のみ) ----
  // 受け入れ条件 (#34): フォールバックの成否は console.log で残す。
  if (env.CF_ACCOUNT_ID && env.BROWSER_RENDERING_API_TOKEN) {
    console.log(
      `fetch fallback: trying browser-rendering for ${url} (jina: ${lastErr ?? 'failed'})`,
    )
    try {
      const md = await fetchViaBrowserRendering(url, env)
      if (md) {
        console.log(`fetch fallback: browser-rendering succeeded for ${url}`)
        return { md, title: extractJinaTitle(md), via: 'browser-rendering' }
      }
      lastErr = `${lastErr ?? 'jina failed'}; browser-rendering empty`
      console.log(`fetch fallback: browser-rendering empty for ${url}`)
    } catch (e) {
      lastErr = `${lastErr ?? 'jina failed'}; browser-rendering ${(e as Error).message}`
      console.log(
        `fetch fallback: browser-rendering failed for ${url} (${(e as Error).message})`,
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

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchViaBrowserRendering(
  url: string,
  env: Bindings,
): Promise<string> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`
  const res = await fetchWithTimeout(
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
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  // REST API は { success, result } を返す。result が文字列 (markdown) 想定。
  const data = (await res.json()) as {
    success?: boolean
    result?: string | { markdown?: string }
    errors?: unknown
  }
  if (typeof data.result === 'string') return data.result.trim()
  if (data.result && typeof data.result.markdown === 'string') {
    return data.result.markdown.trim()
  }
  return ''
}
