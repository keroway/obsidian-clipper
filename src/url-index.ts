export type IndexEntry = { path: string; createdAt: string }
export type UrlIndex = Record<string, IndexEntry>

// writeUrlIndexCAS が書き込みをスキップしたときの通知文言 (#145)。原因ごとに
// 文言を分け、ストレージ書き込み失敗を JSON 破損と誤って断定しないようにする。
export function indexSkipMessage(
  reason: 'corrupted' | 'storage-error' | undefined,
  path: string,
): string {
  const detail =
    reason === 'corrupted'
      ? 'urls.json が壊れているため'
      : 'urls.json への書き込みに失敗したため'
  return `[obsidian-clipper] ${detail}重複検知インデックスの更新をスキップしました: ${path}`
}

// バイト列の SHA-1 hex ダイジェスト。画像等バイナリの content hash 重複検知に使う (ADR 0011)。
export async function sha1HexBytes(
  data: ArrayBuffer | Uint8Array,
): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function sha1Hex(text: string): Promise<string> {
  return sha1HexBytes(new TextEncoder().encode(text))
}

type ReadResult = { index: UrlIndex; etag?: string; corrupted?: boolean }

// JSON としては valid でも UrlIndex のスキーマ (非配列 object, 各 entry が
// string の path/createdAt を持つ Record) から外れている場合を弾く (#109)。
function isValidUrlIndex(value: unknown): value is UrlIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as IndexEntry).path === 'string' &&
      typeof (entry as IndexEntry).createdAt === 'string',
  )
}

// index を etag と共に読む。CAS 書き込みの前提となる現在の etag を保持するため。
// JSON パースに失敗した場合、または JSON としては valid でも UrlIndex のスキーマ外
// (null / 配列 / 不正な entry 等) の場合は空の index を返しつつ `corrupted: true` を
// 立てて、「index が存在しない」場合と区別できるようにする (呼び出し元が誤って
// 上書きしないため, #109)。
export async function readUrlIndex(
  vault: R2Bucket,
  key: string,
): Promise<ReadResult> {
  const obj = await vault.get(key)
  if (!obj) return { index: {} }
  let parsed: unknown
  try {
    parsed = await obj.json()
  } catch (err) {
    console.warn(`readUrlIndex: failed to parse "${key}" as JSON`, err)
    return { index: {}, etag: obj.etag, corrupted: true }
  }
  if (!isValidUrlIndex(parsed)) {
    console.warn(`readUrlIndex: "${key}" is valid JSON but not a UrlIndex`)
    return { index: {}, etag: obj.etag, corrupted: true }
  }
  return { index: parsed, etag: obj.etag }
}

const CAS_MAX_ATTEMPTS = 2

export type WriteUrlIndexResult = {
  written: boolean
  // 書き込みをスキップ/失敗した理由。呼び出し元がユーザー向け通知文言を
  // 出し分けるために使う (#145: ストレージ書き込み失敗を JSON 破損と
  // 誤って通知していた問題の修正)。
  //   'corrupted'     — 既存 urls.json がスキーマ外/パース不能で上書きを回避した (#92)
  //   'storage-error' — vault.get/put 自体が reject した (#132)
  reason?: 'corrupted' | 'storage-error'
}

/**
 * index を楽観ロック (Compare-And-Swap) で更新する (ADR 0010)。
 *
 * `mutate` で index を書き換えた後、読み込み時点の etag が一致する場合のみ PUT する
 * (`onlyIf: { etagMatches }`)。index が存在しない場合は `etagDoesNotMatch: '*'` で
 * 新規作成のみを許可する。プリコンディション不一致 (= 他リクエストとの競合) の場合は
 * put が null を返すので、index を再読込して mutate からやり直す (最大 CAS_MAX_ATTEMPTS 回)。
 * 最終試行でも競合する場合は可用性を優先し、無条件 PUT にフォールバックする
 * (個人ツールでの稀な lost update は許容する)。
 *
 * 既存の `urls.json` が壊れていて (`corrupted: true`) パースできない場合は、
 * 空の index で上書きすると既存の重複検知履歴を丸ごと失うため、書き込みを
 * 中断してログのみ残す (#92)。
 *
 * `vault.get`/`vault.put` 自体が reject した場合 (R2 の一時的なエラー等) も、
 * 呼び出し元まで例外を伝播させると 500 応答になり、クライアントの再送で
 * 二重保存を誘発しうる。そのため呼び出し元と同様に書き込み失敗として扱う (#132)。
 *
 * 戻り値の `written` は「実際に書き込んだか」を示す。呼び出し元はこれを見て、
 * スキップされた場合に `NOTIFY_WEBHOOK_URL` へ通知するかを判断する (#101)。
 * `written: false` のときは `reason` で原因 (index 破損 / ストレージエラー) を
 * 区別できる。呼び出し元はこれを使い分けて通知文言に断定的な誤診断を含めない (#145)。
 */
export async function writeUrlIndexCAS(
  vault: R2Bucket,
  key: string,
  mutate: (index: UrlIndex) => void,
): Promise<WriteUrlIndexResult> {
  try {
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
      const { index, etag, corrupted } = await readUrlIndex(vault, key)
      if (corrupted) {
        console.warn(
          `writeUrlIndexCAS: skipping write to "${key}" because the existing index failed to parse`,
        )
        return { written: false, reason: 'corrupted' }
      }
      mutate(index)
      const body = JSON.stringify(index)
      const result = await vault.put(key, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
      })
      if (result) return { written: true } // 成功
      // null = プリコンディション不一致 (競合)。次のループで再読込・再試行。
    }
    // 最終試行でも競合した場合は可用性優先で無条件 PUT にフォールバック。
    const { index, corrupted } = await readUrlIndex(vault, key)
    if (corrupted) {
      console.warn(
        `writeUrlIndexCAS: skipping fallback write to "${key}" because the existing index failed to parse`,
      )
      return { written: false, reason: 'corrupted' }
    }
    mutate(index)
    await vault.put(key, JSON.stringify(index), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
    return { written: true }
  } catch (err) {
    console.warn(`writeUrlIndexCAS: vault.get/put failed for "${key}"`, err)
    return { written: false, reason: 'storage-error' }
  }
}
