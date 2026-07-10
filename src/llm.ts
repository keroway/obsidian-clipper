import type { Bindings } from './bindings'
import {
  AUTO_TAG_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  SUMMARY_MAX_TOKENS,
  SUMMARY_SYSTEM_PROMPT,
} from './prompts'
import { parseTagList } from './tags'

const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_TIMEOUT_MS = 30_000

export async function summarizeWithProvider(
  env: Bindings,
  md: string,
  title: string | undefined,
): Promise<string> {
  const workersAiModel = env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct'
  if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    const anthropicModel = env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL
    try {
      return await summarizeWithAnthropic(
        env.ANTHROPIC_API_KEY,
        anthropicModel,
        md,
        title,
      )
    } catch (e) {
      // Anthropic 失敗時は 1 回だけ workers-ai にフォールバック (ループは作らない)
      console.warn(
        'anthropic summarize failed, falling back to workers-ai',
        (e as Error).message,
      )
      return await summarize(env.AI, workersAiModel, md, title)
    }
  }
  return await summarize(env.AI, workersAiModel, md, title)
}

async function summarize(
  ai: Ai,
  model: string,
  md: string,
  title: string | undefined,
): Promise<string> {
  const r = (await ai.run(
    model as Parameters<Ai['run']>[0],
    {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryUserPrompt(md, title) },
      ],
      max_tokens: SUMMARY_MAX_TOKENS,
    } as never,
  )) as { response?: string }
  return (r?.response ?? '').toString().trim()
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
  if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    try {
      const text = await anthropicComplete(
        env.ANTHROPIC_API_KEY,
        env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
        AUTO_TAG_SYSTEM_PROMPT,
        userPrompt,
        60,
      )
      return parseTagList(text)
    } catch (e) {
      console.warn(
        'anthropic auto-tag failed, falling back to workers-ai',
        (e as Error).message,
      )
    }
  }
  const model = env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct'
  const r = (await env.AI.run(
    model as Parameters<Ai['run']>[0],
    {
      messages: [
        { role: 'system', content: AUTO_TAG_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 60,
    } as never,
  )) as { response?: string }
  return parseTagList((r?.response ?? '').toString())
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
      const text = await res.text().catch(() => '')
      throw new Error(
        `anthropic ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      )
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
