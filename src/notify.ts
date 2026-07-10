export async function notifyWebhook(
  url: string,
  message: string,
): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
    })
  } catch (e) {
    console.warn('webhook notify failed', (e as Error).message)
  }
}
