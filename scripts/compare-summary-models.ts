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

// プロンプト定数は src/prompts.ts を本番 Worker (src/llm.ts) と共有している (ADR 0009)。
// 以前はここに手動コピーしていたが、本番側を変えたら必ず同期する運用負債があったため共有化した。
import {
  buildSummaryUserPrompt,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
} from '../src/prompts'

// process / Bun は bun ランタイムが提供する。@types/node を足さずに型だけ最小宣言する。
declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
}

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

// モデル1回分の実行結果を4分類のどれかに落とす。空/空白のみの要約は
// 「日本語のみ」の成功扱いにせず失敗として扱う (#164)。
type ResultKind = 'error' | 'empty' | 'foreign' | 'ok'

function classifyResult(r: ModelResult): ResultKind {
  if (r.error) return 'error'
  if (r.summary.trim().length === 0) return 'empty'
  if (r.foreign.length > 0) return 'foreign'
  return 'ok'
}

// モデルごとの集計。executed (実行件数) / validEvaluated (有効要約の評価件数) を
// 分母として明示的に分けることで、urls.length を分母に使う誤集計 (#164) を防ぐ。
type ModelAggregate = {
  executed: number
  errors: number
  emptySummaries: number
  validEvaluated: number
  foreignArticles: number
  totalMs: number
}

function newAggregate(): ModelAggregate {
  return {
    executed: 0,
    errors: 0,
    emptySummaries: 0,
    validEvaluated: 0,
    foreignArticles: 0,
    totalMs: 0,
  }
}

function recordResult(a: ModelAggregate, r: ModelResult): ResultKind {
  a.executed++
  a.totalMs += r.latencyMs
  const kind = classifyResult(r)
  if (kind === 'error') {
    a.errors++
  } else if (kind === 'empty') {
    a.emptySummaries++
  } else {
    a.validEvaluated++
    if (kind === 'foreign') a.foreignArticles++
  }
  return kind
}

function formatAggregateRow(
  model: string,
  totalUrls: number,
  a: ModelAggregate,
): string {
  const notRun = totalUrls - a.executed
  const avgLatency =
    a.executed > 0 ? `${Math.round(a.totalMs / a.executed)}ms` : 'N/A(未実行)'
  const foreignRate =
    a.validEvaluated > 0
      ? `${a.foreignArticles}/${a.validEvaluated}`
      : 'N/A・未評価'
  return `| \`${model}\` | ${a.executed}/${totalUrls} | ${notRun} | ${a.errors} | ${a.emptySummaries} | ${a.validEvaluated} | ${avgLatency} | ${foreignRate} |`
}

type ReportDeps = {
  fetchMarkdown: (url: string) => Promise<string>
  runModel: (
    model: string,
    md: string,
    title: string | undefined,
  ) => Promise<ModelResult>
}

// main() から環境変数解決 / 引数解析を切り離した本体。テストからは
// fetchMarkdown / runModel をモックして注入できる (#164 の回帰検証)。
async function buildReport(
  urls: string[],
  models: string[],
  deps: ReportDeps,
): Promise<string> {
  const out: string[] = []
  out.push('# Workers AI 要約モデル比較レポート')
  out.push('')
  out.push(`- 生成: ${new Date().toISOString()}`)
  out.push(`- 候補モデル: ${models.map((m) => `\`${m}\``).join(', ')}`)
  out.push(
    `- システムプロンプト / 抜粋上限 / max_tokens は src/index.ts と同一`,
  )
  out.push('')

  const agg = new Map<string, ModelAggregate>()
  for (const m of models) agg.set(m, newAggregate())
  let fetchFailures = 0

  for (const url of urls) {
    console.error(`fetching: ${url}`)
    let md = ''
    try {
      md = await deps.fetchMarkdown(url)
    } catch (e) {
      fetchFailures++
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
      const r = await deps.runModel(model, md, title)
      // biome-ignore lint/style/noNonNullAssertion: key guaranteed by agg initialization above
      const a = agg.get(model)!
      const kind = recordResult(a, r)

      const flag =
        kind === 'error'
          ? `❌ error: ${r.error}`
          : kind === 'empty'
            ? '❌ 空要約'
            : kind === 'foreign'
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
  out.push(`- 本文取得失敗: ${fetchFailures}/${urls.length}`)
  const allInconclusive = models.every(
    (m) => (agg.get(m) as ModelAggregate).validEvaluated === 0,
  )
  if (allInconclusive) {
    out.push(
      '- ⚠ 全モデルで有効要約の評価件数が0件のため、比較は不成立 (本文取得失敗またはモデル失敗/空要約のみ)。',
    )
  }
  out.push('')
  out.push(
    '| モデル | 実行 | 未実行 | 失敗 | 空要約 | 有効評価 | 平均レイテンシ(実行時) | 他言語混入(有効評価内) |',
  )
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const m of models) {
    out.push(formatAggregateRow(m, urls.length, agg.get(m) as ModelAggregate))
  }
  out.push('')
  out.push(
    '> コスト観点は Workers AI 価格表 (https://developers.cloudflare.com/workers-ai/platform/pricing/) と照合して別途記入すること。',
  )

  return out.join('\n')
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

  const report = await buildReport(urls, models, {
    fetchMarkdown: (url) => fetchMarkdown(url, jinaKey),
    runModel: (model, md, title) =>
      runModel(accountId, token, model, md, title),
  })

  console.log(report)
}

// bun scripts/compare-summary-models.ts で直接実行されたときだけ main() を走らせる。
// テストからの import では実行しない。
if (import.meta.main) {
  main()
}

export { buildReport, classifyResult, type ModelResult }
