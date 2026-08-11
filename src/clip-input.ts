// POST /clip の入力種別判別 (ADR 0011)。
// Content-Type / JSON ボディの内容だけで種別を決める純関数群。workerd 起動なしでテストできる。

export type UrlClipBody = {
  url: string
  title?: string
  selection?: string
  note?: string
  tags?: string[]
}

export type TextClipBody = {
  markdown?: string
  text?: string
  title?: string
  note?: string
  tags?: string[]
}

// `droppedTags` は「tags に不正な値が含まれていて捨てた」ことを示す (#75)。
// 正規化して処理を続けるが、黙って捨てると送信側は気づけないため呼び出し側で
// 警告できるようにする。
export type ClassifiedJsonBody =
  | { kind: 'url'; body: UrlClipBody; droppedTags: boolean }
  | { kind: 'text'; body: TextClipBody; droppedTags: boolean }

// Content-Type ヘッダから multipart か json かを判定する。
// multipart/form-data はブラウザ/curl が boundary をパラメータとして付与するので前方一致で判定する。
export function detectContentKind(
  contentType: string | undefined,
): 'multipart' | 'json' {
  if (contentType?.toLowerCase().startsWith('multipart/form-data')) {
    return 'multipart'
  }
  return 'json'
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

// 任意の文字列フィールドを取り出す。文字列でなければ undefined。
//
// 以前は `as unknown as UrlClipBody` で素通しており、`title` に数値や配列を
// 送ると `payload.title?.trim()` が実行時に落ちて 500 になっていた (#75)。
function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// タグ配列を取り出す。**文字列を配列として受け取らない**のが要点 (#75)。
//
// 以前は型検証なしに `mergeTags(['clipped', ...manualTags])` へ spread して
// いたため、`"tags": "test"` のような送信ミスが 1 文字ずつのタグ
// (`clipped, t, e, s, t`) として frontmatter に書き込まれていた。
// エラーにならず、壊れた出力だけが残る silent corruption。
//
// 配列でない場合と、配列の中の非文字列要素は捨てる。**拒否ではなく正規化**を
// 選ぶのは、クリップ自体は成功させたいため (タグの送信ミスで本文を失うのは
// 割に合わない)。捨てた事実は呼び出し側が警告できるよう別途返す。
function normalizeTags(v: unknown): { tags: string[]; dropped: boolean } {
  if (v === undefined || v === null) return { tags: [], dropped: false }
  if (!Array.isArray(v)) return { tags: [], dropped: true }
  const tags = v.filter((item): item is string => typeof item === 'string')
  return { tags, dropped: tags.length !== v.length }
}

// パース済み JSON ボディを url クリップ / テキストクリップに分類する。
// どちらにも該当しなければ null (呼び出し側で 400 にする)。
//
// **キャストで素通しせず、フィールドごとに型を検証して組み直す** (#75)。
// 素通しすると、型注釈は付いているのに実際の値が違うという状態になり、
// 下流が `.trim()` や spread で壊れる。
export function classifyJsonBody(body: unknown): ClassifiedJsonBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const { tags, dropped } = normalizeTags(b.tags)

  if (isNonEmptyString(b.url)) {
    return {
      kind: 'url',
      body: {
        url: b.url,
        title: optionalString(b.title),
        selection: optionalString(b.selection),
        note: optionalString(b.note),
        tags,
      },
      droppedTags: dropped,
    }
  }
  if (isNonEmptyString(b.markdown) || isNonEmptyString(b.text)) {
    return {
      kind: 'text',
      body: {
        markdown: optionalString(b.markdown),
        text: optionalString(b.text),
        title: optionalString(b.title),
        note: optionalString(b.note),
        tags,
      },
      droppedTags: dropped,
    }
  }
  return null
}
