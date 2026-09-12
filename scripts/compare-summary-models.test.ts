import { describe, expect, it } from 'vitest'
import {
  buildReport,
  classifyResult,
  type ModelResult,
} from './compare-summary-models'

// #164: 本文取得失敗・空要約がエラー0件として集計される不具合の回帰テスト。
// fetchMarkdown / runModel を通信モックで差し替え、実ネットワークには一切触れない。

function okResult(model: string, summary: string): ModelResult {
  return { model, summary, latencyMs: 10, foreign: [] }
}

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
    expect(report).not.toContain('✅ 日本語のみ')
    expect(report).toMatch(
      /\| `test-model` \| 5\/5 \| 0 \| 0 \| 5 \| 0 \| \d+ms \| N\/A・未評価 \|/,
    )
  })

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
})
