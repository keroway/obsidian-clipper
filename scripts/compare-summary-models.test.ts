import { describe, expect, it, vi } from 'vitest'
import {
  buildReport,
  classifyResult,
  fetchMarkdown,
  type ModelResult,
  runModel,
} from './compare-summary-models'

// #164: 本文取得失敗・空要約がエラー0件として集計される不具合の回帰テスト。
// fetchMarkdown / runModel を通信モックで差し替え、実ネットワークには一切触れない。

function okResult(model: string, summary: string): ModelResult {
  return { model, summary, latencyMs: 10, foreign: [] }
}

describe('fetchMarkdown', () => {
  it('空白のみの 200 応答を取得失敗にする (#245)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('  \n ', { status: 200 })) as unknown as typeof fetch
    try {
      await expect(fetchMarkdown('https://example.invalid')).rejects.toThrow(
        'jina empty body',
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

// #287: signal が abort されたら reject する、永久に完了しない待機を作る。
function hang(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    )
  })
}

describe('通信タイムアウト (#287)', () => {
  it('fetchMarkdown: ヘッダー待機が期限を超えたら取得失敗にする', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      hang(init?.signal)) as unknown as typeof fetch
    try {
      await expect(
        fetchMarkdown('https://example.invalid', undefined, 20),
      ).rejects.toThrow('jina timeout after 20ms')
    } finally {
      globalThis.fetch = original
    }
  })

  it('fetchMarkdown: 本文読み取りが期限を超えたら取得失敗にする', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => hang(init?.signal),
      })) as unknown as typeof fetch
    try {
      await expect(
        fetchMarkdown('https://example.invalid', undefined, 20),
      ).rejects.toThrow('jina timeout after 20ms')
    } finally {
      globalThis.fetch = original
    }
  })

  it('runModel: ヘッダー待機が期限を超えたら error 結果を返す', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      hang(init?.signal)) as unknown as typeof fetch
    try {
      const r = await runModel('acc', 'tok', 'model', 'body', undefined, 20)
      expect(r.error).toBe('timeout after 20ms')
      expect(classifyResult(r)).toBe('error')
    } finally {
      globalThis.fetch = original
    }
  })

  it('runModel: 本文読み取りが期限を超えたら error 結果を返す', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => hang(init?.signal),
      })) as unknown as typeof fetch
    try {
      const r = await runModel('acc', 'tok', 'model', 'body', undefined, 20)
      expect(r.error).toBe('timeout after 20ms')
    } finally {
      globalThis.fetch = original
    }
  })

  it('取得がタイムアウトしても後続記事の処理を続ける', async () => {
    const report = await buildReport(
      ['https://a.test', 'https://b.test'],
      ['m'],
      {
        fetchMarkdown: async (url) => {
          if (url === 'https://a.test')
            throw new Error('jina timeout after 20ms')
          return 'Title: B\n本文'.repeat(10)
        },
        runModel: async (model) => okResult(model, '有効な要約'),
      },
    )
    expect(report).toContain('本文取得失敗: jina timeout after 20ms')
    expect(report).toContain('本文取得失敗: 1/2')
    expect(report).toContain('有効な要約')
  })
})

describe('runModel', () => {
  // #282: ヘッダー受信 (t=10) 後に本文読み取りが遅れる (t=110) 応答を再現する。
  async function latencyFor(res: {
    ok: boolean
    status: number
    body: unknown
  }): Promise<number> {
    let now = 0
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      now = 10
      return {
        ok: res.ok,
        status: res.status,
        json: async () => {
          now = 110
          return res.body
        },
      }
    }) as unknown as typeof fetch
    try {
      const r = await runModel('acc', 'tok', 'model', 'body', undefined)
      return r.latencyMs
    } finally {
      globalThis.fetch = original
      spy.mockRestore()
    }
  }

  it('成功時のレイテンシに本文読み取り時間を含める', async () => {
    expect(
      await latencyFor({
        ok: true,
        status: 200,
        body: { success: true, result: { response: 'ok' } },
      }),
    ).toBe(110)
  })

  it('API エラー時のレイテンシにも本文読み取り時間を含める', async () => {
    expect(
      await latencyFor({
        ok: false,
        status: 500,
        body: { success: false, errors: [{ message: 'boom' }] },
      }),
    ).toBe(110)
  })

  it.each([{ unexpected: 'payload' }, 42, true, ['a']])(
    '非文字列の response %j を要約として受理せずエラーにする (#285)',
    async (response) => {
      const original = globalThis.fetch
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { response } }),
      })) as unknown as typeof fetch
      try {
        const r = await runModel('acc', 'tok', 'model', 'body', undefined)
        expect(r.error).toContain('non-string response')
        expect(classifyResult(r)).toBe('error')
      } finally {
        globalThis.fetch = original
      }
    },
  )

  it('response 欠落は空要約のまま扱う (#285)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: {} }),
    })) as unknown as typeof fetch
    try {
      const r = await runModel('acc', 'tok', 'model', 'body', undefined)
      expect(r.error).toBeUndefined()
      expect(classifyResult(r)).toBe('empty')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('classifyResult', () => {
  it('空要約を成功 (日本語のみ) ではなく失敗として分類する', () => {
    expect(classifyResult(okResult('m', ''))).toBe('empty')
    expect(classifyResult(okResult('m', '   \n  '))).toBe('empty')
  })

  it('非空・他言語なしを成功として分類する', () => {
    expect(classifyResult(okResult('m', '要約本文'))).toBe('ok')
  })

  it('error フィールドがあればエラーとして分類する', () => {
    expect(
      classifyResult({
        model: 'm',
        summary: '',
        latencyMs: 5,
        foreign: [],
        error: 'boom',
      }),
    ).toBe('error')
  })
})

describe('buildReport', () => {
  const models = ['model-a', 'model-b']

  it('全件本文取得失敗のとき、モデル実行0回・比較不成立を集計に反映する', async () => {
    const report = await buildReport(
      ['https://a.example', 'https://b.example'],
      models,
      {
        fetchMarkdown: async () => {
          throw new Error('jina 503')
        },
        runModel: async () => {
          throw new Error('runModel は呼ばれないはず')
        },
      },
    )

    expect(report).toContain('本文取得失敗: 2/2')
    expect(report).toContain('比較は不成立')
    // 実行0件なので平均レイテンシ・言語混入率は N/A、エラー欄は0のまま (未実行と混同しない)
    expect(report).toMatch(
      /\| `model-a` \| 0\/2 \| 2 \| 0 \| 0 \| 0 \| N\/A\(未実行\) \| N\/A・未評価 \|/,
    )
  })

  it('全件空要約のとき、有効評価0件・空要約カウントに反映し成功扱いしない', async () => {
    const urls = Array.from(
      { length: 5 },
      (_, i) => `https://example.invalid/${i}`,
    )
    const report = await buildReport(urls, ['test-model'], {
      fetchMarkdown: async () => 'Title: Offline fixture\n本文'.repeat(10),
      runModel: async (model) => okResult(model, ''),
    })

    expect(report).toContain('本文取得失敗: 0/5')
    expect(report).toContain('比較は不成立')
    expect(report).not.toContain('✅ 検査対象の文字混入なし')
    expect(report).toMatch(
      /\| `test-model` \| 5\/5 \| 0 \| 0 \| 5 \| 0 \| \d+ms \| N\/A・未評価 \|/,
    )
  })

  it('英語だけの要約を日本語のみと断定せず、検査範囲を明示する (#246)', async () => {
    const report = await buildReport(['https://en.example'], ['model-a'], {
      fetchMarkdown: async () => 'Title: English\n本文'.repeat(10),
      runModel: async (model) => okResult(model, 'This is an English summary.'),
    })

    expect(report).not.toContain('日本語のみ')
    expect(report).toContain('✅ 検査対象の文字混入なし')
  })

  it.each(['', '   \n  '])(
    '空本文 %j はモデルを呼ばず本文取得失敗として集計する (#245)',
    async (body) => {
      let calls = 0
      const report = await buildReport(['https://empty.example'], ['model-a'], {
        fetchMarkdown: async () => body,
        runModel: async (model) => {
          calls++
          return okResult(model, '要約')
        },
      })

      expect(calls).toBe(0)
      expect(report).toContain('本文取得失敗: 1/1')
      expect(report).toContain('比較は不成立')
      expect(report).not.toContain('✅ 検査対象の文字混入なし')
    },
  )

  it('本文取得成功・失敗が混在するとき、有効評価件数を正しい分母で集計する', async () => {
    const urls = [
      'https://ok.example/1',
      'https://fail.example',
      'https://ok.example/2',
    ]
    const report = await buildReport(urls, ['model-a'], {
      fetchMarkdown: async (url) => {
        if (url.includes('fail')) throw new Error('jina 503')
        return 'Title: OK\n本文'
      },
      runModel: async (model) => okResult(model, '有効な要約'),
    })

    expect(report).toContain('本文取得失敗: 1/3')
    expect(report).not.toContain('比較は不成立')
    // 実行は2回 (取得成功分のみ)、有効評価も2件、分母はurls.lengthの3ではない
    expect(report).toMatch(
      /\| `model-a` \| 2\/3 \| 1 \| 0 \| 0 \| 2 \| \d+ms \| 0\/2 \|/,
    )
  })

  it('モデルの重複指定を一意化し、二重実行と負の未実行件数を防ぐ (#299)', async () => {
    const runModel = vi.fn(async (model: string) => okResult(model, '要約'))
    const report = await buildReport(
      ['https://example.com/article'],
      ['model-a', 'model-b', 'model-a'],
      { fetchMarkdown: async () => 'Title: Example\n本文', runModel },
    )

    expect(runModel).toHaveBeenCalledTimes(2)
    expect(report.match(/^\| `model-a` \|/gm)).toHaveLength(1)
    expect(report).toMatch(/\| `model-a` \| 1\/1 \| 0 \|/)
    expect(report).not.toContain('| -1 |')
  })
})
