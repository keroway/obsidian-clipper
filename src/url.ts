import { HTTPException } from 'hono/http-exception'

// どのドメインでも削って安全なパラメータ。
// いずれも計測専用の命名で、コンテンツの同定に使われることはない。
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
  '_hsenc',
  '_hsmi',
])

// **特定ホストでのみ**削るパラメータ (#73)。
//
// `s` / `t` / `si` は X や YouTube では共有用のトラッキングだが、一般的な
// クエリ名でもある。ホストを見ずに削ると別サイトの意味あるパラメータを壊す:
//
//   - WordPress の既定検索は `?s=<検索語>`。削ると検索結果ページが
//     トップページに化ける
//   - YouTube の `?t=120` は再生開始位置。削ると「ここから見て」が失われる
//     (`si` は共有トラッキングなので YouTube でも削ってよい)
//
// 実際に `https://blog.example.com/?s=gleam` が `https://blog.example.com/` へ、
// `https://www.youtube.com/watch?v=abc&t=120` が `?v=abc` へ縮んでいた。
const HOST_SCOPED_TRACKING_PARAMS: ReadonlyArray<
  readonly [suffix: string, params: readonly string[]]
> = [
  ['x.com', ['s', 't']],
  ['twitter.com', ['s', 't']],
  ['youtube.com', ['si']],
  ['youtu.be', ['si']],
]

// ホスト名がサフィックスと一致するか。サブドメインも後方一致で拾う
// (例: m.youtube.com)。`evil-x.com` のような別ホストを誤って拾わないよう、
// 部分一致ではなくドット境界で判定する。
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

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
  const hostScoped = new Set(
    HOST_SCOPED_TRACKING_PARAMS.filter(([suffix]) =>
      hostMatches(u.hostname, suffix),
    ).flatMap(([, params]) => params),
  )
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k) || hostScoped.has(k)) u.searchParams.delete(k)
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
