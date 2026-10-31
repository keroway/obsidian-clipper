// 画像クリップ (multipart) の文字列パートが不正な UTF-8 を含まないか検証する (#331)。
// Response.formData() は不正バイトを U+FFFD に置換して成功扱いにするため、
// 解析前の生バイト列でファイルパート (filename 付き) 以外を fatal デコードで確認する。
// JSON 経路の fatal 検証 (#309, src/json-body.ts) に対応する。

const CRLF = [0x0d, 0x0a]
const HEADER_END = [0x0d, 0x0a, 0x0d, 0x0a]

function boundaryOf(contentType: string): string | null {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return m ? (m[1] ?? m[2] ?? null) : null
}

function indexOfBytes(
  hay: Uint8Array,
  needle: Uint8Array | number[],
  from: number,
): number {
  const first = needle[0] as number
  const last = hay.length - needle.length
  for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue
    let j = 1
    while (j < needle.length && hay[i + j] === needle[j]) j++
    if (j === needle.length) return i
  }
  return -1
}

// delimiter 候補 (body[idx] から delimLen バイト) の直後が区切り行として成立するか (#335)。
// 終端なら 'close'、通常の区切りなら 'part'、本文中の偽物 (--abc--not-a-boundary 等) なら null。
// 後続は (空白/タブの transport padding +) CRLF か入力末尾でなければならない。
function delimiterKind(
  body: Uint8Array,
  idx: number,
  delimLen: number,
): 'part' | 'close' | null {
  let p = idx + delimLen
  const close = body[p] === 0x2d && body[p + 1] === 0x2d
  if (close) p += 2
  while (body[p] === 0x20 || body[p] === 0x09) p++
  const lineEnd = p >= body.length || (body[p] === 0x0d && body[p + 1] === 0x0a)
  if (!lineEnd) return null
  return close ? 'close' : 'part'
}

// from 以降で行頭 (直前が CRLF、または先頭) にある正当な delimiter を探す。
function findDelimiter(
  body: Uint8Array,
  delim: Uint8Array,
  from: number,
): { index: number; kind: 'part' | 'close' } | null {
  let i = indexOfBytes(body, delim, from)
  while (i !== -1) {
    const atLineStart =
      i === 0 || (body[i - 2] === 0x0d && body[i - 1] === 0x0a)
    if (atLineStart) {
      const kind = delimiterKind(body, i, delim.length)
      if (kind) return { index: i, kind }
    }
    i = indexOfBytes(body, delim, i + 1)
  }
  return null
}

// Content-Disposition ヘッダーの実際の filename / filename* パラメータだけをファイル判定の根拠にする (#333)。
// 他ヘッダーや引用符内の "filename=" では判定しない。
function hasFilenameParam(headers: string): boolean {
  for (const line of headers.split('\r\n')) {
    if (!/^content-disposition\s*:/i.test(line)) continue
    const unquoted = line.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    if (/;\s*filename\*?\s*=/i.test(unquoted)) return true
  }
  return false
}

// 文字列パート (filename を持たないパート) のバイト列が不正な UTF-8 を含むなら false。
// boundary が取れない/構造が壊れている場合は判定せず true を返す
// (構造エラーは後続の formData() が 400 にする)。
export function multipartTextPartsAreValidUtf8(
  body: Uint8Array,
  contentType: string,
): boolean {
  const boundary = boundaryOf(contentType)
  if (!boundary) return true

  const encoder = new TextEncoder()
  const delim = encoder.encode(`--${boundary}`)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const latin1 = new TextDecoder('latin1')

  let cur = findDelimiter(body, delim, 0)
  while (cur) {
    // 終端 boundary (--boundary--)
    if (cur.kind === 'close') return true
    const afterDelim = cur.index + delim.length

    const headStart = indexOfBytes(body, CRLF, afterDelim)
    if (headStart === -1) return true
    const headEnd = indexOfBytes(body, HEADER_END, headStart)
    if (headEnd === -1) return true
    const bodyStart = headEnd + HEADER_END.length

    // 次の delimiter (直前に CRLF が付く)
    const next = findDelimiter(body, delim, bodyStart)
    const bodyEnd = next ? next.index - 2 : body.length

    const headers = latin1.decode(body.subarray(headStart + 2, headEnd))
    if (!hasFilenameParam(headers)) {
      try {
        decoder.decode(body.subarray(bodyStart, bodyEnd))
      } catch {
        return false
      }
    }
    cur = next
  }
  return true
}
