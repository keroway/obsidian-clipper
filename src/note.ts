// Windows / macOS / Obsidian で扱いにくい文字
const INVALID_FILENAME_RE = /[\\/:*?"<>|[\]#^`]/g

export function sanitizeForFilename(name: string): string {
  return name
    .slice(0, 200)
    .replace(INVALID_FILENAME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
}

function yamlEscape(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderNote(opts: {
  url?: string
  source?: string
  title?: string
  summary?: string
  note?: string
  selection?: string
  tags?: string[]
  body?: string
  createdIso: string
  fetchErr?: string
}): string {
  // ---- frontmatter ----
  const fm: string[] = ['---']
  fm.push(`created: ${opts.createdIso}`)
  fm.push(`updated: ${opts.createdIso}`)
  fm.push(`source: ${opts.source ?? 'web-clip'}`)
  if (opts.url) fm.push(`source_url: ${yamlEscape(opts.url)}`)
  if (opts.title) fm.push(`source_title: ${yamlEscape(opts.title)}`)
  // タグの正規化・重複排除・clipped 前置は呼び出し側 (mergeTags) の責務。
  // ここでは渡された値をそのまま描画する。
  const tags = opts.tags ?? []
  fm.push('tags:')
  for (const t of tags) fm.push(`  - ${yamlEscape(t)}`)
  if (opts.summary) {
    fm.push(`summary: ${yamlEscape(opts.summary.replace(/\s+/g, ' '))}`)
  }
  fm.push('---')

  // ---- body ----
  const parts: string[] = [fm.join('\n'), '']
  if (opts.title) parts.push(`# ${opts.title}`, '')
  if (opts.url) parts.push(`<${opts.url}>`, '')

  if (opts.note) {
    parts.push('> [!note] メモ')
    parts.push(`> ${opts.note.replace(/\n/g, '\n> ')}`)
    parts.push('')
  }
  if (opts.summary) {
    parts.push('## 要約')
    parts.push(opts.summary)
    parts.push('')
  }
  if (opts.selection) {
    parts.push('## 抜粋')
    parts.push(`> ${opts.selection.replace(/\n/g, '\n> ')}`)
    parts.push('')
  }
  if (opts.body) {
    parts.push('## 本文')
    parts.push(opts.body)
    parts.push('')
  } else if (opts.fetchErr) {
    parts.push('## 本文')
    parts.push(
      `> 本文取得に失敗しました (${opts.fetchErr}). 後で手動で開いてください。`,
    )
    parts.push('')
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n')
}
