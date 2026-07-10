// JST (UTC+9) 固定のタイムスタンプ生成。Worker は UTC で動くため、
// Date を直接フォーマットせずここを経由すること。

export function jstStamp(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
    `_${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
  )
}

export function jstIso(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
    `T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}+09:00`
  )
}
