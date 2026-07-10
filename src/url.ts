import { HTTPException } from 'hono/http-exception'

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
  'si',
  '_hsenc',
  '_hsmi',
  's', // X (Twitter) の共有用
  't', // X (Twitter) の共有用
])

export function normalizeUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new HTTPException(400, { message: 'invalid url' })
  }
  // X (旧 Twitter) ドメイン揺れの正規化
  if (u.hostname === 'mobile.twitter.com' || u.hostname === 'twitter.com') {
    u.hostname = 'x.com'
  }
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k)) u.searchParams.delete(k)
  }
  // 末尾の / は残す/消すで割れるので触らない
  return u.toString()
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
