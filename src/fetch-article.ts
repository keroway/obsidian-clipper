import type { Bindings } from './bindings'
import { InvalidUtf8Error, readTextWithLimit } from './bounded-body'
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
// Browser Rendering の JSON 応答の受信上限計算用 (本文上限とは別, #327)
const JSON_ESCAPE_FACTOR = 6
const JSON_ENVELOPE_BYTES = 1024

function extractJinaTitle(md: string): string | undefined {
  // 空白は水平空白に限る。\s だと空の Title 行から次行まで取り込んでしまう (#280)
  const m = md.match(/^Title:[ \t]*([^\r\n]*)$/m)
  return m?.[1].trim() || undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 自前で投げる、message が固定または安全な値だけで組まれた失敗 (#369)。
 * この型の message だけはログ・err へそのまま載せてよい。
 */
class SafeFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

/**
 * 例外をログ・err へ載せる固定分類へ変換する (#353, #369)。
 * 任意の例外 message には要求 URL・認証値・本文断片が含まれうる (ADR 0012) ため、
 * 自前の SafeFetchError 以外は message を一切載せず、例外種別だけで分類する。
 */
export function describeFetchError(e: unknown): string {
  if (e instanceof SafeFetchError) return e.message
  if (e instanceof InvalidUtf8Error) return 'invalid UTF-8'
  const name = e instanceof Error || e instanceof DOMException ? e.name : ''
  switch (name) {
    case 'AbortError':
    case 'TimeoutError':
      return 'aborted'
    case 'TypeError':
      return 'network error'
    case 'SyntaxError':
      return 'invalid JSON'
    default:
      return 'error'
  }
}

const bodyTooLargeMessage = (maxBytes: number) =>
  `article body too large (> ${maxBytes} bytes)`

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
          let md: string | null
          try {
            md = await readTextWithLimit(res, maxBytes, { strictUtf8: true })
          } catch (e) {
            if (!(e instanceof InvalidUtf8Error)) throw e
            // 不正 UTF-8 は文字化け本文を成功扱いにしない (#345)。同じ本文が
            // 再取得でも返るため、リトライもフォールバックもしない。
            lastErr = 'jina invalid UTF-8 body'
            retryableFailure = false
            break
          }
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
        // 不要な本文ストリームは待機・終了より前に解放する (#383)。cancel の
        // 拒否・未完了でクリップ処理を止めないよう await しない。
        releaseBody(res)
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
      lastErr = `jina ${describeFetchError(e)}`
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
      const detail = describeFetchError(e)
      lastErr = `${lastErr ?? 'jina failed'}; browser-rendering ${detail}`
      console.log(
        `fetch fallback: browser-rendering failed for ${host} (${detail})`,
      )
    }
  }

  return { md: '', err: lastErr ?? 'fetch failed' }
}

// 読まない応答本文の cancel を開始する。結果は待たず、拒否も握り潰す。
function releaseBody(res: Response): void {
  try {
    res.body?.cancel().catch(() => {})
  } catch {
    // 同期例外も無視 (解放はベストエフォート)
  }
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

// errors は [{ code, message }] 想定。上流の自由文 (message) は本文断片や認証情報を
// 含みうるため、ログ・err には載せない (#363, ADR 0012)。整数の code だけを出す。
function describeErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return ''
  const codes = errors
    .map((e) => (e as { code?: unknown } | null)?.code)
    .filter((c): c is number => Number.isSafeInteger(c))
    .slice(0, 5)
  return codes.length ? ` (code ${codes.join(',')})` : ''
}

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

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
      // 応答本文の断片は載せない (#363)。ステータスのみ。
      await res.body?.cancel().catch(() => {})
      throw new SafeFetchError(`${res.status}`)
    }
    // REST API は { success, result } を返す。result が文字列 (markdown) 想定。
    // 受信上限は JSON エンベロープと最悪ケース (制御文字 1 バイト = \uXXXX の 6 バイト)
    // のエスケープ分を見込んだ有限値にし、本文上限は取り出した Markdown の UTF-8
    // バイト数で判定する。Jina 経路と同じ本文が同じ結果になるようにする (#327)。
    const raw = await readTextWithLimit(
      res,
      maxBytes * JSON_ESCAPE_FACTOR + JSON_ENVELOPE_BYTES,
      // 不正 UTF-8 は U+FFFD 置換の文字化け本文を成功扱いにしない (#347)。
      // InvalidUtf8Error は呼び出し元の catch で取得失敗経路に接続される。
      { strictUtf8: true },
    )
    if (raw === null) return null
    const data = JSON.parse(raw) as {
      success?: boolean
      result?: string | { markdown?: string }
      errors?: unknown
    }
    // success=false は result が非空でも失敗として扱う (#329)。
    if (data.success === false) {
      throw new SafeFetchError(`success=false${describeErrors(data.errors)}`)
    }
    const md =
      typeof data.result === 'string'
        ? data.result
        : typeof data.result?.markdown === 'string'
          ? data.result.markdown
          : ''
    // JSON の \uD800 エスケープは生バイトとしては正常 UTF-8 なので strictUtf8 では
    // 弾けない。孤立サロゲートは UTF-8 化で U+FFFD に変質するため失敗扱いにする (#360)。
    if (LONE_SURROGATE_RE.test(md)) {
      throw new SafeFetchError(
        'browser-rendering result contains lone surrogate',
      )
    }
    if (new TextEncoder().encode(md).byteLength > maxBytes) return null
    return md.trim()
  } finally {
    clear()
  }
}
