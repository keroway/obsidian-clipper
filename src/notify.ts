// webhook への通知。**この関数自身の失敗は通知できない**（通知経路が壊れている
// ときに使うため）ので、ログに残すのが唯一の手段になる。
//
// 以前は `fetch` の例外だけを catch しており、**HTTP ステータスを見ていなかった**
// （#72）。webhook 側が 401/404/500 を返しても成功として素通りし、
// 「本文取得失敗」「要約失敗」「タグ生成失敗」の通知が届いていないことに
// 誰も気づけない状態だった。通知の仕組み自体が silent fallback になっていた。
export async function notifyWebhook(
  url: string,
  message: string,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
    })
    if (!res.ok) {
      // 本文も出す。webhook 側は理由をボディに書くことが多く、
      // ステータスだけでは「なぜ弾かれたか」が分からない。
      const detail = await safeReadBody(res)
      console.warn(
        `webhook notify failed: ${res.status} ${res.statusText}${detail}`,
      )
    }
  } catch (e) {
    console.warn('webhook notify failed', (e as Error).message)
  }
}

// エラー本文の読み取りで**さらに失敗しても**元のエラー報告を潰さない。
// 長い HTML が返ることもあるので切り詰める。
async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return ''
    const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text
    return ` — ${trimmed}`
  } catch {
    return ''
  }
}
