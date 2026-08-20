export type IndexEntry = { path: string; createdAt: string }
export type UrlIndex = Record<string, IndexEntry>

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

// index を etag と共に読む。CAS 書き込みの前提となる現在の etag を保持するため。
// JSON パースに失敗した場合は空の index を返しつつ `corrupted: true` を立てて、
// 「index が存在しない」場合と区別できるようにする (呼び出し元が誤って上書きしないため)。
export async function readUrlIndex(
  vault: R2Bucket,
  key: string,
): Promise<ReadResult> {
  const obj = await vault.get(key)
  if (!obj) return { index: {} }
  try {
    return { index: (await obj.json()) as UrlIndex, etag: obj.etag }
  } catch (err) {
    console.warn(`readUrlIndex: failed to parse "${key}" as JSON`, err)
    return { index: {}, etag: obj.etag, corrupted: true }
  }
}

const CAS_MAX_ATTEMPTS = 2

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
 */
export async function writeUrlIndexCAS(
  vault: R2Bucket,
  key: string,
  mutate: (index: UrlIndex) => void,
): Promise<void> {
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const { index, etag, corrupted } = await readUrlIndex(vault, key)
    if (corrupted) {
      console.warn(
        `writeUrlIndexCAS: skipping write to "${key}" because the existing index failed to parse`,
      )
      return
    }
    mutate(index)
    const body = JSON.stringify(index)
    const result = await vault.put(key, body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
    })
    if (result) return // 成功
    // null = プリコンディション不一致 (競合)。次のループで再読込・再試行。
  }
  // 最終試行でも競合した場合は可用性優先で無条件 PUT にフォールバック。
  const { index, corrupted } = await readUrlIndex(vault, key)
  if (corrupted) {
    console.warn(
      `writeUrlIndexCAS: skipping fallback write to "${key}" because the existing index failed to parse`,
    )
    return
  }
  mutate(index)
  await vault.put(key, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
}
