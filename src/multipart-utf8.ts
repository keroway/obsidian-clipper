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

  let pos = indexOfBytes(body, delim, 0)
  while (pos !== -1) {
    const afterDelim = pos + delim.length
    // 終端 boundary (--boundary--)
    if (body[afterDelim] === 0x2d && body[afterDelim + 1] === 0x2d) return true

    const headStart = indexOfBytes(body, CRLF, afterDelim)
    if (headStart === -1) return true
    const headEnd = indexOfBytes(body, HEADER_END, headStart)
    if (headEnd === -1) return true
    const bodyStart = headEnd + HEADER_END.length

    // 次の delimiter (直前に CRLF が付く)
    let next = indexOfBytes(body, delim, bodyStart)
    while (
      next !== -1 &&
      !(body[next - 2] === 0x0d && body[next - 1] === 0x0a)
    ) {
      next = indexOfBytes(body, delim, next + 1)
    }
    const bodyEnd = next === -1 ? body.length : next - 2

    const headers = latin1.decode(body.subarray(headStart + 2, headEnd))
    if (!hasFilenameParam(headers)) {
      try {
        decoder.decode(body.subarray(bodyStart, bodyEnd))
      } catch {
        return false
      }
    }
    pos = next
  }
  return true
}
