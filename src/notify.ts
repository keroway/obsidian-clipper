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
import { releaseBody } from './bounded-body'

export const WEBHOOK_TIMEOUT_MS = 5000

export async function notifyWebhook(
  url: string,
  message: string,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
      signal: controller.signal,
    })
    // 本文は成功・失敗を問わず不要なので、読まずに破棄する（cancel の完了は待たない, #397）。
    releaseBody(res)
    if (!res.ok) {
      // 応答本文・statusText・例外メッセージは自由文で、機密を含みうる
      // （ADR 0012: ログに機密を載せない, #365）。HTTP ステータスの整数のみ記録する。
      console.warn(`webhook notify failed: ${res.status}`)
    }
  } catch {
    console.warn('webhook notify failed: request error or timeout')
  } finally {
    clearTimeout(timer)
  }
}
