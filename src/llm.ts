import type { Bindings } from './bindings'
import { readErrorSnippet } from './error-body'
import {
  AUTO_TAG_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
} from './prompts'
import { hasValidTag, parseTagList } from './tags'

const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000
export const WORKERS_AI_TIMEOUT_MS = 30_000

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
          new Error(
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
      if (!text) throw new Error('anthropic returned empty summary')
      return text
    } catch (e) {
      // Anthropic 失敗時は 1 回だけ workers-ai にフォールバック (ループは作らない)
      console.warn(
        'anthropic summarize failed, falling back to workers-ai',
        (e as Error).message,
      )
      const fallback = await summarize(env.AI, workersAiModel, md, title)
      if (!fallback) throw new Error('workers-ai returned empty summary')
      return fallback
    }
  }
  const result = await summarize(env.AI, workersAiModel, md, title)
  if (!result) throw new Error('workers-ai returned empty summary')
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
    throw new Error(
      `workers-ai returned non-string response: ${typeof response}`,
    )
  }
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
        throw new Error('anthropic returned no usable tags')
      return tags
    } catch (e) {
      // 要約と同じく Anthropic 失敗時は 1 回だけ workers-ai にフォールバックする
      // (空応答・正規化後に有効タグが残らない場合も失敗として扱う)。
      console.warn(
        'anthropic auto-tag failed, falling back to workers-ai',
        (e as Error).message,
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
    throw new Error(
      `workers-ai returned non-string response: ${typeof response}`,
    )
  }
  const tags = parseTagList((response ?? '').toString())
  if (!hasValidTag(tags)) throw new Error('workers-ai returned no usable tags')
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
      const text = await readErrorSnippet(res)
      throw new Error(`anthropic ${res.status}${text ? `: ${text}` : ''}`)
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}
