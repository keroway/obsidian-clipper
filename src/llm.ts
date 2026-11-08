import type { Bindings } from './bindings'
import { readTextWithLimit } from './bounded-body'
import {
  AUTO_TAG_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
} from './prompts'
import { hasValidTag, parseTagList } from './tags'

const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000
export const WORKERS_AI_TIMEOUT_MS = 30_000

// 成功応答・生成要約のサイズ上限 (#270)。要約は max_tokens=300 で数百〜千数百文字に
// 収まるため、上限は異常応答 (巨大ノート生成) だけを弾く余裕を持たせた値にする。
// 超過は throw し、要約は既存のフォールバック/要約失敗通知 (本文保存は継続) に接続する。
const ANTHROPIC_RESPONSE_MAX_BYTES = 64 * 1024

export { SUMMARY_MAX_CHARS }

// 本モジュールが自前で組み立てた固定文言の失敗 (#367)。message に外部由来の自由文を
// 含めないので、そのままログ・Webhook に載せてよい。それ以外の例外 (fetch / JSON.parse /
// Workers AI バインディング由来) の message は本文・URL・認証値を含みうるため転記しない。
export class LlmFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmFailure'
  }
}

// ログ・通知に出してよい失敗の分類文字列を返す。任意の例外 message は返さない。
export function describeLlmError(e: unknown): string {
  if (e instanceof LlmFailure) return e.message
  const name = e instanceof Error ? e.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  if (name === 'InvalidUtf8Error') return 'invalid utf-8 response'
  if (name === 'SyntaxError') return 'invalid json response'
  if (name === 'TypeError') return 'network or type error'
  return 'unexpected error'
}

function assertSummaryLength(provider: string, text: string): void {
  if (text.length > SUMMARY_MAX_CHARS) {
    throw new LlmFailure(
      `${provider} summary too long (${text.length} > ${SUMMARY_MAX_CHARS} chars)`,
    )
  }
}

// 孤立サロゲートを含む文字列は UTF-8 化で U+FFFD に変質するため失敗扱いにする (#356)。
// 正常なサロゲートペア (絵文字等) と明示的な U+FFFD は通す。
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function assertWellFormed(provider: string, text: string): void {
  if (LONE_SURROGATE_RE.test(text)) {
    throw new LlmFailure(`${provider} response contains lone surrogate`)
  }
}

// Workers AI の ai.run は AbortSignal を受け取れないため、待機だけを打ち切る。
// 期限超過は reject として呼び出し側の既存失敗処理 (空要約・空タグで保存継続) に渡す。
// 処理自体はキャンセルされず、遅れて完了した結果は破棄される。
async function withWorkersAiTimeout<T>(
  work: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new LlmFailure(
            `workers-ai ${label} timed out after ${WORKERS_AI_TIMEOUT_MS}ms`,
          ),
        ),
      WORKERS_AI_TIMEOUT_MS,
    )
  })
  // 期限後に work が reject しても unhandled rejection にしない。
  work.catch(() => {})
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer ?? null)
  }
}

export async function summarizeWithProvider(
  env: Bindings,
  md: string,
  title: string | undefined,
): Promise<string> {
  const workersAiModel = env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct'
  if (env.SUMMARY_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    console.warn(
      'SUMMARY_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set, falling back to workers-ai',
    )
  }
  if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    const anthropicModel = env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL
    try {
      const text = await summarizeWithAnthropic(
        env.ANTHROPIC_API_KEY,
        anthropicModel,
        md,
        title,
      )
      if (!text) throw new LlmFailure('anthropic returned empty summary')
      assertSummaryLength('anthropic', text)
      return text
    } catch (e) {
      // Anthropic 失敗時は 1 回だけ workers-ai にフォールバック (ループは作らない)
      console.warn(
        'anthropic summarize failed, falling back to workers-ai',
        describeLlmError(e),
      )
      const fallback = await summarize(env.AI, workersAiModel, md, title)
      if (!fallback) throw new LlmFailure('workers-ai returned empty summary')
      assertSummaryLength('workers-ai', fallback)
      return fallback
    }
  }
  const result = await summarize(env.AI, workersAiModel, md, title)
  if (!result) throw new LlmFailure('workers-ai returned empty summary')
  assertSummaryLength('workers-ai', result)
  return result
}

async function summarize(
  ai: Ai,
  model: string,
  md: string,
  title: string | undefined,
): Promise<string> {
  const r = (await withWorkersAiTimeout(
    ai.run(
      model as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: buildSummaryUserPrompt(md, title) },
        ],
        max_tokens: SUMMARY_MAX_TOKENS,
      } as never,
    ),
    'summarize',
  )) as { response?: unknown }
  const response = r?.response
  if (response === undefined || response === null) return ''
  if (typeof response !== 'string') {
    throw new LlmFailure(
      `workers-ai returned non-string response: ${typeof response}`,
    )
  }
  assertWellFormed('workers-ai', response)
  return response.trim()
}

function summarizeWithAnthropic(
  apiKey: string,
  model: string,
  md: string,
  title: string | undefined,
): Promise<string> {
  return anthropicComplete(
    apiKey,
    model,
    SUMMARY_SYSTEM_PROMPT,
    buildSummaryUserPrompt(md, title),
    SUMMARY_MAX_TOKENS,
  )
}

// 本文 + タイトルから LLM でタグを最大 MAX_AUTO_TAGS 個生成する。
// 要約と同じ provider 設計 (Anthropic / workers-ai) を踏襲。失敗時は throw。
export async function generateTags(
  env: Bindings,
  md: string,
  title: string | undefined,
): Promise<string[]> {
  const userPrompt = buildSummaryUserPrompt(md, title)
  if (env.SUMMARY_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    console.warn(
      'SUMMARY_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set, falling back to workers-ai',
    )
  }
  if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    try {
      const text = await anthropicComplete(
        env.ANTHROPIC_API_KEY,
        env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
        AUTO_TAG_SYSTEM_PROMPT,
        userPrompt,
        60,
      )
      const tags = parseTagList(text)
      if (!hasValidTag(tags))
        throw new LlmFailure('anthropic returned no usable tags')
      return tags
    } catch (e) {
      // 要約と同じく Anthropic 失敗時は 1 回だけ workers-ai にフォールバックする
      // (空応答・正規化後に有効タグが残らない場合も失敗として扱う)。
      console.warn(
        'anthropic auto-tag failed, falling back to workers-ai',
        describeLlmError(e),
      )
    }
  }
  const model = env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct'
  const r = (await withWorkersAiTimeout(
    env.AI.run(
      model as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: AUTO_TAG_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 60,
      } as never,
    ),
    'auto-tag',
  )) as { response?: unknown }
  const response = r?.response
  if (
    response !== undefined &&
    response !== null &&
    typeof response !== 'string'
  ) {
    throw new LlmFailure(
      `workers-ai returned non-string response: ${typeof response}`,
    )
  }
  const text = (response ?? '').toString()
  assertWellFormed('workers-ai', text)
  const tags = parseTagList(text)
  if (!hasValidTag(tags))
    throw new LlmFailure('workers-ai returned no usable tags')
  return tags
}

// Anthropic Messages API の汎用 1 往復呼び出し。system/user/max_tokens を受け取り
// テキストを返す。失敗時は throw (呼び出し側でフォールバック/degrade を判断)。
async function anthropicComplete(
  apiKey: string,
  model: string,
  system: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // 上流のエラー本文は例外メッセージに含めない (#355)。メッセージは console.warn と
      // webhook 通知にそのまま渡るため、自由文を載せると ADR 0012 の方針に反して複製される。
      // 本文は読み捨てて接続を解放し、ステータスだけを残す。
      await res.body?.cancel().catch(() => {})
      throw new LlmFailure(`anthropic ${res.status}`)
    }
    // 不正 UTF-8 は U+FFFD 置換で成功扱いにせず throw し、フォールバック経路へ渡す (#349)
    const raw = await readTextWithLimit(res, ANTHROPIC_RESPONSE_MAX_BYTES, {
      strictUtf8: true,
    })
    if (raw === null) {
      throw new LlmFailure(
        `anthropic response too large (> ${ANTHROPIC_RESPONSE_MAX_BYTES} bytes)`,
      )
    }
    const data = JSON.parse(raw) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
    // JSON の \uD800 エスケープは生バイトとしては正常 UTF-8 なので strictUtf8 では弾けない (#356)
    assertWellFormed('anthropic', text)
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}
