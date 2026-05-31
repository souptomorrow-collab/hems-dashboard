/* 數值格式化工具 */

export const fmtKw = (v, d = 2) => `${Number(v).toFixed(d)}`
export const fmtKwh = (v, d = 1) => `${Number(v).toFixed(d)}`
export const fmtPct = (v, d = 0) => `${Number(v).toFixed(d)}%`
export const fmtMoney = (v, d = 0) => `${Number(v).toFixed(d)}`

/** 補零的兩位數 */
export const pad2 = (n) => String(n).padStart(2, '0')

/** Date → "YYYY/MM/DD（週X）" */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
export function fmtDate(date) {
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(
    date.getDate()
  )}（週${WEEKDAYS[date.getDay()]}）`
}

/** Date → "HH:MM:SS" */
export function fmtClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds()
  )}`
}

/** 取得明日的 Date（規劃頁用，預設為隔日） */
export function tomorrow(date = new Date()) {
  const d = new Date(date)
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d
}
