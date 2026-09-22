/* ============================================================
   平常（沒開展示模式）模擬用的可轉移設備作息

   比較接近台灣一般家庭的使用頻率（2026-09-22 和使用者討論後定的）：
     洗衣機  週一、三、五、六  10:00～11:00
     烘衣機  週六              11:00～12:30（接在洗衣機之後）
     洗碗機  每天              21:00～22:00
   平常模式的模擬照這個作息開關設備，不再由模擬自己挑最便宜的時段；
   展示模式則照資料庫裡使用者存下的設定（預設三台都關，展示時打開才跑）。
   days：1＝週一 … 7＝週日（ISO 星期），和 hems.user_prefs 的 days 相同。
   ============================================================ */
import { SLOTS_PER_DAY } from './constants.js'

export const SIM_ROUTINE = {
  washer: { enabled: true, slots: [['10:00', '11:00']], days: [1, 3, 5, 6] },
  dryer: { enabled: true, slots: [['11:00', '12:30']], days: [6] },
  dishwasher: { enabled: true, slots: [['21:00', '22:00']], days: [1, 2, 3, 4, 5, 6, 7] },
}

const toSlot = (hhmm) => (hhmm === '24:00' ? SLOTS_PER_DAY : Number(hhmm.slice(0, 2)) * 4 + Number(hhmm.slice(3)) / 15)

/** 某一天照作息各設備每格開不開：{ washer: boolean[96], … }；那天不是它開的日子就整列 false */
export function routineRows(date, routine = SIM_ROUTINE) {
  const wd = date.getDay() || 7
  const out = {}
  for (const [id, p] of Object.entries(routine)) {
    const row = new Array(SLOTS_PER_DAY).fill(false)
    if (p.enabled !== false && (p.days ?? [1, 2, 3, 4, 5, 6, 7]).includes(wd)) {
      for (const [a, b] of p.slots ?? []) {
        for (let s = toSlot(a); s < toSlot(b) && s < SLOTS_PER_DAY; s++) row[s] = true
      }
    }
    out[id] = row
  }
  return out
}
