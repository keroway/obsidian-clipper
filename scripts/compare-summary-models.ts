#!/usr/bin/env bun
/**
 * compare-summary-models.ts
 *
 * Issue #16: Workers AI の要約モデルを「同一条件」で比較するための再現可能ハーネス。
 *
 * 本番 Worker (src/index.ts) と同じシステムプロンプト・抜粋上限・max_tokens で、
 * 候補モデルそれぞれに同じ記事を要約させ、要約文 / レイテンシ / 他言語混入の有無を
 * Markdown 表で出力する。出力をそのまま Issue #5 のコメントに貼れる形にしている。
 *
 * Workers AI の実行には Cloudflare アカウントが要るため、wrangler ではなく
 * CF REST API (/accounts/{id}/ai/run/{model}) を直叩きする。これにより
 * wrangler.jsonc の R2 バインディング等の設定なしで単体実行できる。
 *
 * 使い方:
 *   export CF_ACCOUNT_ID=<account id>
 *   export CF_API_TOKEN=<Workers AI 実行権限のある API トークン>
 *   export JINA_API_KEY=<任意。未設定でも動くが rate limit が緩くなる>
 *   bun run scripts/compare-summary-models.ts                  # 既定の候補と sample-articles.txt
 *   bun run scripts/compare-summary-models.ts --models @cf/x,@cf/y
 *   bun run scripts/compare-summary-models.ts https://example.com/a https://example.com/b
 *
 * 出力 (Markdown) はそのまま #5 にコメントすること (受け入れ条件 2)。
 */

// process / Bun は bun ランタイムが提供する。@types/node を足さずに型だけ最小宣言する。
declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
}

// ─────────────────────────────────────────────────────────────────────────────
// src/index.ts と同期必須 (挙動契約)。比較の忠実性のため意図的にコピーしている。
// src/index.ts 側の SUMMARY_SYSTEM_PROMPT / SUMMARY_EXCERPT_LIMIT /
// buildSummaryUserPrompt / max_tokens を変えたら、ここも必ず合わせること。
const SUMMARY_SYSTEM_PROMPT =
  'あなたは技術記事を日本語で要約するアシスタントです。' +
  '出力は3〜5文の散文で、最初の1文に結論を置き、専門用語はそのまま残してください。' +
  '箇条書きや見出しは使わないでください。'
const SUMMARY_EXCERPT_LIMIT = 6000
const SUMMARY_MAX_TOKENS = 300

function buildSummaryUserPrompt(md: string, title: string | undefined): string {
  const excerpt = md.slice(0, SUMMARY_EXCERPT_LIMIT)
  return [title ? `タイトル: ${title}` : '', '本文:', excerpt]
    .filter(Boolean)
    .join('\n')
}
// ─────────────────────────────────────────────────────────────────────────────

// 比較対象の候補モデル。先頭が現行既定。詳細は #5 のコメント参照。
// ここに載せるのは「実際に /ai/run が通った」モデル ID のみ (Workers AI の
// ラインナップは入れ替わり、誤った ID は `No route for that URI` で全滞する)。
// 他モデル (Qwen / Gemma 等) を試すときは、必ず公式一覧で現行 ID を確認してから
// `--models` で渡すこと: https://developers.cloudflare.com/workers-ai/models/
const DEFAULT_CANDIDATE_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct', // 現行既定。低コスト・高速で #16 の採用モデル
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // 大型・高品質だが 5〜7 倍遅くコスト高
  '@cf/mistralai/mistral-small-3.1-24b-instruct', // 中型・多言語
]

// 他言語混入の検知に使う Unicode ブロック。日本語 (ひらがな/カタカナ/漢字) と
// ASCII は許可。ここに当たる文字が出たら「混入あり」とフラグする。
const FOREIGN_SCRIPTS: Array<{ name: string; re: RegExp }> = [
  { name: 'Cyrillic', re: /[Ѐ-ӿ]/ },
  { name: 'Hangul', re: /[가-힯ᄀ-ᇿ]/ },
  { name: 'Thai', re: /[฀-๿]/ },
  { name: 'Arabic', re: /[؀-ۿ]/ },
  { name: 'Devanagari', re: /[ऀ-ॿ]/ },
  { name: 'Greek', re: /[Ͱ-Ͽ]/ },
]

type ModelResult = {
  model: string
  summary: string
  latencyMs: number
  foreign: string[]
  error?: string
}

function parseArgs(argv: string[]): { models: string[]; urls: string[] } {
  const urls: string[] = []
  let models = DEFAULT_CANDIDATE_MODELS
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--models') {
      models = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (a.startsWith('http')) {
      urls.push(a)
    }
  }
  return { models, urls }
}

// sample-articles.txt から URL を読む (# 始まりはコメント、空行は無視)。
async function readSampleUrls(): Promise<string[]> {
  const path = new URL('./sample-articles.txt', import.meta.url)
  try {
    const text = await Bun.file(path).text()
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

async function fetchMarkdown(url: string, jinaKey?: string): Promise<string> {
  const headers: Record<string, string> = {}
  if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`
  const res = await fetch(`https://r.jina.ai/${url}`, { headers })
  if (!res.ok) throw new Error(`jina ${res.status}`)
  return (await res.text()).trim()
}

async function runModel(
  accountId: string,
  token: string,
  model: string,
  md: string,
  title: string | undefined,
): Promise<ModelResult> {
  const started = Date.now()
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: buildSummaryUserPrompt(md, title) },
          ],
          max_tokens: SUMMARY_MAX_TOKENS,
        }),
      },
    )
    const latencyMs = Date.now() - started
    const data = (await res.json()) as {
      success?: boolean
      result?: { response?: string }
      errors?: Array<{ message?: string }>
    }
    if (!res.ok || !data.success) {
      const msg =
        data.errors?.map((e) => e.message).join('; ') || `http ${res.status}`
      return { model, summary: '', latencyMs, foreign: [], error: msg }
    }
    const summary = (data.result?.response ?? '').toString().trim()
    const foreign = FOREIGN_SCRIPTS.filter((s) => s.re.test(summary)).map(
      (s) => s.name,
    )
    return { model, summary, latencyMs, foreign }
  } catch (e) {
    return {
      model,
      summary: '',
      latencyMs: Date.now() - started,
      foreign: [],
      error: (e as Error).message,
    }
  }
}

function deriveTitle(md: string): string | undefined {
  // Jina 出力は先頭付近に "Title: ..." を含むことが多い。無ければ最初の見出し。
  const titleLine = md.match(/^Title:\s*(.+)$/m)?.[1]
  if (titleLine) return titleLine.trim()
  return md.match(/^#\s+(.+)$/m)?.[1]?.trim()
}

async function main() {
  const accountId = process.env.CF_ACCOUNT_ID
  const token = process.env.CF_API_TOKEN
  const jinaKey = process.env.JINA_API_KEY
  if (!accountId || !token) {
    console.error(
      'CF_ACCOUNT_ID と CF_API_TOKEN を環境変数で設定してください。',
    )
    process.exit(1)
  }

  const { models, urls: argUrls } = parseArgs(process.argv.slice(2))
  const urls = argUrls.length > 0 ? argUrls : await readSampleUrls()
  if (urls.length === 0) {
    console.error(
      'URL がありません。引数で渡すか scripts/sample-articles.txt に記載してください。',
    )
    process.exit(1)
  }
  if (urls.length < 5) {
    console.error(
      `⚠ URL が ${urls.length} 本です。受け入れ条件は 5 本以上。続行はしますが追加を推奨します。`,
    )
  }

  const out: string[] = []
  out.push('# Workers AI 要約モデル比較レポート')
  out.push('')
  out.push(`- 生成: ${new Date().toISOString()}`)
  out.push(`- 候補モデル: ${models.map((m) => `\`${m}\``).join(', ')}`)
  out.push(
    `- システムプロンプト / 抜粋上限 / max_tokens は src/index.ts と同一`,
  )
  out.push('')

  // 集計用: モデルごとの混入記事数と平均レイテンシ
  const agg = new Map<
    string,
    { foreignArticles: number; totalMs: number; errors: number }
  >()
  for (const m of models)
    agg.set(m, { foreignArticles: 0, totalMs: 0, errors: 0 })

  for (const url of urls) {
    console.error(`fetching: ${url}`)
    let md = ''
    try {
      md = await fetchMarkdown(url, jinaKey)
    } catch (e) {
      out.push(`## ${url}`)
      out.push('')
      out.push(`> ⚠ 本文取得失敗: ${(e as Error).message}`)
      out.push('')
      continue
    }
    const title = deriveTitle(md)

    out.push(`## ${title ?? url}`)
    out.push('')
    out.push(`<${url}>`)
    out.push('')

    for (const model of models) {
      console.error(`  running: ${model}`)
      const r = await runModel(accountId, token, model, md, title)
      // biome-ignore lint/style/noNonNullAssertion: key guaranteed by agg initialization above
      const a = agg.get(model)!
      a.totalMs += r.latencyMs
      if (r.error) a.errors++
      if (r.foreign.length > 0) a.foreignArticles++

      const flag = r.error
        ? `❌ error: ${r.error}`
        : r.foreign.length > 0
          ? `⚠ 他言語混入: ${r.foreign.join(', ')}`
          : '✅ 日本語のみ'
      out.push(`### \`${model}\` — ${r.latencyMs}ms — ${flag}`)
      out.push('')
      out.push(r.summary ? `> ${r.summary.replace(/\n/g, '\n> ')}` : '> (空)')
      out.push('')
    }
  }

  out.push('## 集計')
  out.push('')
  out.push('| モデル | 平均レイテンシ | 他言語混入記事 | エラー |')
  out.push('| --- | --- | --- | --- |')
  for (const m of models) {
    // biome-ignore lint/style/noNonNullAssertion: key guaranteed by agg initialization above
    const a = agg.get(m)!
    const avg = urls.length ? Math.round(a.totalMs / urls.length) : 0
    out.push(
      `| \`${m}\` | ${avg}ms | ${a.foreignArticles}/${urls.length} | ${a.errors} |`,
    )
  }
  out.push('')
  out.push(
    '> コスト観点は Workers AI 価格表 (https://developers.cloudflare.com/workers-ai/platform/pricing/) と照合して別途記入すること。',
  )

  console.log(out.join('\n'))
}

main()
