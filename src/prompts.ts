// 要約・自動タグ生成の共有プロンプト定義。
// scripts/compare-summary-models.ts と本番 Worker (src/llm.ts) の双方から
// import される。以前は compare スクリプト側に手動コピーしており「本番側を
// 変えたら必ず同期する」運用負債があったため、共有モジュール化した (ADR 0009)。

// モデルのコンテキストに収めるため先頭を切り出す上限
export const SUMMARY_EXCERPT_LIMIT = 6000
export const SUMMARY_MAX_TOKENS = 300

// 生成要約の文字数上限 (#270)。本番 (src/llm.ts) と比較スクリプトで共有する (#303)。
export const SUMMARY_MAX_CHARS = 4000

export const SUMMARY_SYSTEM_PROMPT =
  'あなたは技術記事を日本語で要約するアシスタントです。' +
  '出力は3〜5文の散文で、最初の1文に結論を置き、専門用語はそのまま残してください。' +
  '箇条書きや見出しは使わないでください。'

export const MAX_AUTO_TAGS = 3

export const AUTO_TAG_SYSTEM_PROMPT =
  'あなたは技術記事にタグを付けるアシスタントです。' +
  '記事内容を表すタグを最大3個、半角カンマ区切りで出力してください。' +
  '各タグは小文字の短い英単語または日本語の固有名詞短語にし、説明文や記号は付けず、タグのみを出力してください。'

export function buildSummaryUserPrompt(
  md: string,
  title: string | undefined,
): string {
  let end = Math.min(md.length, SUMMARY_EXCERPT_LIMIT)
  // 切断位置が上位・下位サロゲートの間なら、孤立上位サロゲートを残さないよう1つ戻す (#409)
  if (end < md.length) {
    const last = md.charCodeAt(end - 1)
    const next = md.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end -= 1
    }
  }
  const excerpt = md.slice(0, end)
  return [title ? `タイトル: ${title}` : '', '本文:', excerpt]
    .filter(Boolean)
    .join('\n')
}
