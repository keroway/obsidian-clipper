// クリップ 1 件 1 行の構造化イベント (ADR 0012)。
//
// Workers Logs はオブジェクトで console.log するとフィールドを索引化するので、
// ダッシュボードで `event = clip` を outcome 別に絞れる。**URL のパス・クエリ、
// タイトル、本文、タグ、認証情報は載せない**(host のみ。warningTarget と同方針, #262)。
// フィールドを足すときはこの型に足し、機密を含まないことをテストで確認する。

export type ClipKind = 'url' | 'text' | 'image' | 'unknown'
export type ClipOutcome = 'saved' | 'duplicate' | 'error'

// ハンドラ内で分かる詳細。リクエスト単位で c.set('clipDetails', ...) に積む。
export type ClipDetails = {
  kind?: ClipKind
  host?: string
  fetchVia?: 'jina' | 'jina-retry' | 'browser-rendering' | 'none'
  fetchFailed?: boolean
  summaryFailed?: boolean
  tagsFailed?: boolean
  // Anthropic 失敗で workers-ai に縮退した (#442)。成功しても品質が落ちているので別に記録する。
  summaryFallback?: boolean
  tagsFallback?: boolean
  noteFailed?: boolean
  // ノート保存後の重複インデックス更新が失敗した (#456)。理由は固定分類のみ。
  indexFailed?: boolean
  indexFailReason?: 'corrupted' | 'storage-error'
}

export type ClipEvent = ClipDetails & {
  event: 'clip'
  kind: ClipKind
  outcome: ClipOutcome
  status: number
  durationMs: number
}

export function buildClipEvent(input: {
  details: ClipDetails
  status: number
  duplicate: boolean
  durationMs: number
}): ClipEvent {
  const { details, status, duplicate, durationMs } = input
  const outcome: ClipOutcome =
    status >= 400 ? 'error' : duplicate ? 'duplicate' : 'saved'
  // undefined のフィールドは出力から落とす(索引に空キーを作らない)
  const defined = Object.fromEntries(
    Object.entries(details).filter(([, v]) => v !== undefined),
  )
  return {
    ...defined,
    event: 'clip',
    kind: details.kind ?? 'unknown',
    outcome,
    status,
    durationMs,
  }
}

export function logClipEvent(event: ClipEvent): void {
  console.log(event)
}
