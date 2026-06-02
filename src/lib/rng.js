/* 共用的種子亂數與日期工具
   讓同一天的模擬資料（太陽能、天氣、排程）穩定可重現，不會每次 render 都亂跳。 */

/** 種子亂數產生器（mulberry32） */
export function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由日期產生穩定種子（年 * 1000 + 一年中第幾天） */
export function seedFromDate(date) {
  return date.getFullYear() * 1000 + dayOfYear(date)
}

/** 一年中的第幾天（1~366） */
export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0)
  return Math.floor((date - start) / 86400000)
}
