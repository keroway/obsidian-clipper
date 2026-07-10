import type { Bindings } from './bindings'
import { MAX_AUTO_TAGS } from './prompts'
import { hostname } from './url'

const MAX_AUTO_TAGS_TOTAL = 8

// ホスト名サフィックス → 固定タグの既定 allowlist。LLM 不要で確実に付与する。
// AUTO_TAGS_ALLOWLIST env で追記可能 (resolveHostTagRules 参照)。
const DEFAULT_HOST_TAG_RULES: ReadonlyArray<[string, string]> = [
  ['zenn.dev', 'zenn'],
  ['qiita.com', 'qiita'],
  ['note.com', 'note'],
  ['hatenablog.com', 'hatena'],
  ['hatena.ne.jp', 'hatena'],
  ['x.com', 'x'],
  ['github.com', 'github'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['speakerdeck.com', 'slides'],
]

// Obsidian / Dataview のタグで扱いにくい文字を除去し、空白はハイフン化して正規化する。
// 戻り値が空文字なら呼び出し側で捨てる。
export function normalizeTag(input: string): string {
  const collapsed = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff_-]/g, '')
    .replace(/-{2,}/g, '-')
  // 先頭/末尾の - と _ を除去。正規表現の末尾アンカー繰り返し (ReDoS) を避けるため
  // 文字単位でトリムする。
  let start = 0
  let end = collapsed.length
  while (
    start < end &&
    (collapsed[start] === '-' || collapsed[start] === '_')
  ) {
    start++
  }
  while (
    end > start &&
    (collapsed[end - 1] === '-' || collapsed[end - 1] === '_')
  ) {
    end--
  }
  return collapsed.slice(start, end)
}

// 複数ソースのタグを正規化 → 重複排除 → 上限で打ち切る。
export function mergeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const n = normalizeTag(t)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= MAX_AUTO_TAGS_TOTAL) break
  }
  return out
}

// AUTO_TAGS_ALLOWLIST ('zenn.dev:zenn,github.com:github' 形式) をパースし、
// 既定ルールにマージした [suffix, tag] 一覧を返す。
// 同一 suffix+tag の重複は除去。不正なエントリ (コロン欠落等) は無視。
export function resolveHostTagRules(
  allowlist: string | undefined,
): ReadonlyArray<[string, string]> {
  if (!allowlist) return DEFAULT_HOST_TAG_RULES
  const rules: Array<[string, string]> = [...DEFAULT_HOST_TAG_RULES]
  const seen = new Set(rules.map(([s, t]) => `${s}\t${t}`))
  for (const entry of allowlist.split(',')) {
    const idx = entry.indexOf(':')
    if (idx <= 0) continue
    const host = entry.slice(0, idx).trim().toLowerCase()
    const tag = normalizeTag(entry.slice(idx + 1))
    if (!host || !tag) continue
    const key = `${host}\t${tag}`
    if (seen.has(key)) continue
    seen.add(key)
    rules.push([host, tag])
  }
  return rules
}

// ホスト名 allowlist 照合。サブドメインも後方一致で拾う (例: foo.hatenablog.com)。
export function hostTagsFor(url: string, env?: Bindings): string[] {
  const h = hostname(url)
  if (!h) return []
  const rules = resolveHostTagRules(env?.AUTO_TAGS_ALLOWLIST)
  const tags: string[] = []
  for (const [suffix, tag] of rules) {
    if (h === suffix || h.endsWith(`.${suffix}`)) tags.push(tag)
  }
  return tags
}

export function parseTagList(s: string): string[] {
  return s
    .split(/[,\n、]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_AUTO_TAGS)
}

// ENABLE_AUTO_TAGS (新) または ENABLE_AUTO_TAG (旧・後方互換) のいずれかが 'true' なら有効。
export function autoTagsEnabled(env: Bindings): boolean {
  return env.ENABLE_AUTO_TAGS === 'true' || env.ENABLE_AUTO_TAG === 'true'
}
