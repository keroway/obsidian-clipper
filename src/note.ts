// Windows / macOS / Obsidian で扱いにくい文字 + 制御文字 (NUL 等)
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL 等の制御文字をファイル名から除去するために意図的に含める
const INVALID_FILENAME_RE = /[\\/:*?"<>|[\]#^`\x00-\x1f\x7f]/g

export function sanitizeForFilename(name: string): string {
  return name
    .slice(0, 200)
    .replace(INVALID_FILENAME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
}

// YAML 二重引用符スカラー内で安全な制御文字エスケープ (\n \r \t は専用エスケープ、
// それ以外の C0 制御文字・DEL・C1 制御文字 (U+0080-U+009F, NEL の U+0085 含む) は \xNN。
// C1 はエスケープしないと PyYAML が解析エラーにする、または NEL のように YAML の
// 改行処理で空白に変質してしまう (issue #187)。
// U+FFFE / U+FFFF (BMP のノンキャラクタ) も YAML 1.1 の c-printable に含まれず、
// エスケープしないと PyYAML が ReaderError で解析失敗する (issue #193)。\uNNNN で退避する。
function yamlEscape(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: YAML スカラー内で制御文字を安全にエスケープするために意図的に含める
    .replace(/[\x00-\x1f\x7f-\x9f￾￿]/g, (c) => {
      switch (c) {
        case '\n':
          return '\\n'
        case '\r':
          return '\\r'
        case '\t':
          return '\\t'
        default: {
          const code = c.charCodeAt(0)
          return code > 0xff
            ? `\\u${code.toString(16).padStart(4, '0')}`
            : `\\x${code.toString(16).padStart(2, '0')}`
        }
      }
    })}"`
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

  return parts.join('\n')
}
