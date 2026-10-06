import { readErrorSnippet } from './error-body'

// webhook への通知。**この関数自身の失敗は通知できない**（通知経路が壊れている
// ときに使うため）ので、ログに残すのが唯一の手段になる。
//
// 以前は `fetch` の例外だけを catch しており、**HTTP ステータスを見ていなかった**
// （#72）。webhook 側が 401/404/500 を返しても成功として素通りし、
// 「本文取得失敗」「要約失敗」「タグ生成失敗」の通知が届いていないことに
// 誰も気づけない状態だった。通知の仕組み自体が silent fallback になっていた。
//
// POST からエラー本文の読み取りまでを含む有限の期限を設ける (#243)。通知先が
// ヘッダーや本文を返さず止まっても、失敗ログを出して処理を完了させるため。
export const WEBHOOK_TIMEOUT_MS = 5000

export async function notifyWebhook(
  url: string,
  message: string,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  const aborted = new Promise<'timeout'>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve('timeout'))
  })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // 本文も出す。webhook 側は理由をボディに書くことが多く、
      // ステータスだけでは「なぜ弾かれたか」が分からない。
      // 本文が止まっても期限でステータスだけ記録する。
      const detail = await Promise.race([safeReadBody(res), aborted])
      console.warn(
        `webhook notify failed: ${res.status} ${res.statusText}${detail === 'timeout' ? ' (error body read timed out)' : detail}`,
      )
    }
  } catch (e) {
    console.warn('webhook notify failed', (e as Error).message)
  } finally {
    clearTimeout(timer)
  }
}

// エラー本文の読み取りで**さらに失敗しても**元のエラー報告を潰さない
// （readErrorSnippet は失敗時に空文字を返す）。長い HTML が返ることもあるので、
// 全量を読まずバイト上限付きで先頭だけ読む (#229)。
async function safeReadBody(res: Response): Promise<string> {
  const text = await readErrorSnippet(res)
  return text ? ` — ${text}` : ''
}
