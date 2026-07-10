// 要約・自動タグ生成の共有プロンプト定義。
// scripts/compare-summary-models.ts と本番 Worker (src/llm.ts) の双方から
// import される。以前は compare スクリプト側に手動コピーしており「本番側を
// 変えたら必ず同期する」運用負債があったため、共有モジュール化した (ADR 0009)。

// モデルのコンテキストに収めるため先頭を切り出す上限
export const SUMMARY_EXCERPT_LIMIT = 6000
export const SUMMARY_MAX_TOKENS = 300

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
  const excerpt = md.slice(0, SUMMARY_EXCERPT_LIMIT)
  return [title ? `タイトル: ${title}` : '', '本文:', excerpt]
    .filter(Boolean)
    .join('\n')
}
