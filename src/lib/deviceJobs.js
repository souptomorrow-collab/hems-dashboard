/* 可轉移設備的條件（2026-09-23 定案：滾動決定、開機才定案；沒排就不開、只排明天；
   和 device_plan/scripts/plan_devices.py 同一套規則）

   使用者只排明天：沒排的設備明天不開，後天要用再排。每台三種：
     auto   系統決定：在「最早開始～最晚完成」內由排程挑開機時間；範圍沒改＝照建議（建議範圍），
            可以超出建議範圍
     fixed  指定時間：從指定的時刻開始連續跑完；那一次當一般負載，系統不挪
     off    不開：沒排就是這個
   硬性限制（指定時間也要守）：烘衣機 22:00 前跑完、要等洗衣機跑完才開。
   每台一天跑一次，以日曆日為單位；洗碗機建議 19:00～07:00＝同一天的 00:00～07:00 或 19:00～24:00。

   建議時間：三台都照建議時最省的開機時間。展示模式是日前排程另外算的（排程組 MILP，設備和電池一起排），
   頁面三給使用者參考、一鍵照建議排；平常模式依電價估（不看太陽能與電池）。
   幾點開：展示模式由日前排程先排出預估時間，當天實時層每 15 分鐘用最新預測重排，排到「現在開」才開機。
   平常模式、或改了條件還沒送出時，這裡依電價估一個最便宜的時間。 */
import { DEVICES, SLOTS_PER_DAY } from './constants.js'
import { SHIFTABLE_RULES } from './simulate.js'

export const SHIFT_IDS = ['washer', 'dryer', 'dishwasher']
/** 硬性限制：最晚要在第幾格前跑完（烘衣機 22:00）。和資料庫 meta.devices 的 hard_end 相同 */
export const HARD_END = { dryer: 88 }
/** 建議範圍（最早開始, 最晚完成）：照建議時系統在這裡面挑開機時間。和 meta.devices 的 window 相同 */
export const DEFAULT_RANGE = { washer: ['06:00', '22:00'], dryer: ['06:00', '22:00'], dishwasher: ['19:00', '07:00'] }

export const nameOf = (id) => DEVICES.find((d) => d.id === id)?.name ?? id
export const durOf = (id) => SHIFTABLE_RULES[id].dur
export const slotOf = (hhmm) => Number(hhmm.slice(0, 2)) * 4 + Number(hhmm.slice(3)) / 15
export const hm = (slot) =>
  `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`

/** 一台照建議的條件：系統在建議範圍內決定 */
const followRec = (id) => ({ mode: 'auto', earliest: DEFAULT_RANGE[id][0], deadline: DEFAULT_RANGE[id][1], start: null })

/** 沒排＝三台都不開（範圍先放建議範圍，改成系統決定時從這裡開始） */
export function defaultCond() {
  return Object.fromEntries(SHIFT_IDS.map((id) => [id, { ...followRec(id), mode: 'off' }]))
}

/** 三台都照建議 */
export const recommendCond = () => Object.fromEntries(SHIFT_IDS.map((id) => [id, followRec(id)]))

/** 這台是不是照建議（系統決定、範圍是建議範圍） */
export const followsRec = (cond, id) =>
  cond?.[id]?.mode === 'auto' && cond[id].earliest === DEFAULT_RANGE[id][0] && cond[id].deadline === DEFAULT_RANGE[id][1]
/** 一台照建議的條件（「照建議」按鈕用） */
export const recCond = followRec

/** API 的格式（GET /prefs 的 devices）→ 條件。沒列出的設備＝沒排（不開） */
export function fromPrefs(devices) {
  const c = defaultCond()
  for (const id of SHIFT_IDS) {
    const p = devices?.[id]
    if (!p || p.enabled === false) continue
    c[id].mode = 'auto'
    if (p.earliest) c[id].earliest = p.earliest
    if (p.deadline) c[id].deadline = p.deadline
    if (p.slots?.length) Object.assign(c[id], { mode: 'fixed', start: slotOf(p.slots[0][0]) })
  }
  return c
}

/** 條件 → API 的格式（POST /prefs）。三台都送（不開的送 enabled false，整份都不開也送得出去）；
    範圍和建議範圍相同就不送；指定時間只送一段 */
export function toPrefs(cond) {
  return Object.fromEntries(SHIFT_IDS.map((id) => {
    const c = cond[id]
    if (c.mode === 'off') return [id, { enabled: false }]
    const out = { enabled: true }
    if (c.earliest !== DEFAULT_RANGE[id][0]) out.earliest = c.earliest
    if (c.deadline !== DEFAULT_RANGE[id][1]) out.deadline = c.deadline
    if (c.mode === 'fixed') out.slots = [[hm(c.start), hm(c.start + durOf(id))]]
    return [id, out]
  }))
}

/** 兩份條件是不是一樣（和已送出的比，看有沒有改過） */
export const condKey = (cond) => JSON.stringify(toPrefs(cond))

/** (最早開始, 最晚完成) → 一天裡可以運轉的格子區間 [[起, 迄)]；最早晚於最晚＝跨午夜，拆成頭尾兩段 */
export function rangesOf(earliest, deadline) {
  const a = slotOf(earliest)
  const b = slotOf(deadline) || SLOTS_PER_DAY
  return a < b ? [[a, b]] : [[a, SLOTS_PER_DAY], [0, b]]
}

/** 系統決定時可以開機的格子（整段都在範圍內、不超過硬性限制） */
export function startsOf(id, c) {
  const n = durOf(id)
  const cap = HARD_END[id] ?? SLOTS_PER_DAY
  const out = new Set()
  for (const [lo, hi] of rangesOf(c.earliest, c.deadline)) {
    for (let s = lo; s + n <= Math.min(hi, cap); s++) out.add(s)
  }
  return [...out].sort((a, b) => a - b)
}

/** 第 slot 格在不在建議範圍內（建議範圍外的格子畫淡一點，仍然可以排） */
export const inDefault = (id, slot) =>
  rangesOf(...DEFAULT_RANGE[id]).some(([a, b]) => slot >= a && slot < b)
/** 指定時間最晚可以從第幾格開始（一天內跑完；烘衣機 22:00 前跑完） */
export const latestStart = (id) => (HARD_END[id] ?? SLOTS_PER_DAY) - durOf(id)
/** 第 slot 格能不能運轉（硬性限制）：烘衣機 22:00 以後不行 */
export const hardOk = (id, slot) => slot < (HARD_END[id] ?? SLOTS_PER_DAY)

/** 烘衣機接在洗衣機之後：兩台都還有得選時，先把彼此不可能的開始時間去掉 */
function pairStarts(cond) {
  const w = cond.washer.mode === 'fixed' ? [cond.washer.start] : startsOf('washer', cond.washer)
  const d = cond.dryer.mode === 'fixed' ? [cond.dryer.start] : startsOf('dryer', cond.dryer)
  if (cond.washer.mode === 'off' || cond.dryer.mode === 'off') return { washer: w, dryer: d, ok: true }
  const dw = durOf('washer')
  const d2 = d.filter((s) => w.length && s >= w[0] + dw)
  const w2 = w.filter((s) => d2.length && s + dw <= d2[d2.length - 1])
  return { washer: w2, dryer: d2, ok: w2.length > 0 && d2.length > 0 }
}

/** 依電價估開機時間：系統決定的挑範圍內最便宜的（同價取早），指定的照指定，不跑的是 null。
    回傳 { 設備: 開機的格子 | null } */
export function estimate(cond, price) {
  const pair = pairStarts(cond)
  const cost = (id, s) => {
    let x = 0
    for (let k = 0; k < durOf(id); k++) x += price[s + k]
    return x
  }
  const cheapest = (id, starts) => starts.reduce((b, s) => (b == null || cost(id, s) < cost(id, b) - 1e-9 ? s : b), null)
  const out = {}
  for (const id of ['washer', 'dishwasher', 'dryer']) {
    const c = cond[id]
    if (c.mode === 'off') out[id] = null
    else if (c.mode === 'fixed') out[id] = c.start
    else if (id === 'dishwasher') out[id] = cheapest(id, startsOf(id, c))
    else if (!pair.ok) out[id] = cheapest(id, startsOf(id, c))     // 衝突時各自估，檢查會擋下送出
    else if (id === 'dryer' && out.washer != null) {
      out[id] = cheapest(id, pair.dryer.filter((s) => s >= out.washer + durOf('washer')))
    } else {
      // 洗衣機：要留時間給烘衣機（烘衣機指定時間時，要在那之前洗完）
      out[id] = cheapest(id, pair[id])
    }
  }
  return out
}

/** 開機的格子 → 96 格 true/false */
export function rowsOf(starts) {
  return Object.fromEntries(SHIFT_IDS.map((id) => {
    const row = new Array(SLOTS_PER_DAY).fill(false)
    const s = starts[id]
    if (s != null) for (let k = 0; k < durOf(id); k++) row[s + k] = true
    return [id, row]
  }))
}

/** 96 格 true/false → 開機的格子（第一個開的格子；沒開就是 null） */
export function startsFromRows(rows) {
  return Object.fromEntries(SHIFT_IDS.map((id) => {
    const i = rows?.[id]?.findIndex(Boolean) ?? -1
    return [id, i >= 0 ? i : null]
  }))
}

/** 條件的問題。error 擋送出（這樣跑不起來）；warn 提醒（可能是故意的：超出建議範圍）。
    指定時間比建議時間多花多少，由頁面三另外算（lib/simulate.js，和預估電費同一套算法） */
export function checkCond(cond) {
  const out = []
  const add = (devId, level, text) => out.push({ devId, level, text })
  for (const id of SHIFT_IDS) {
    const c = cond[id]
    const n = durOf(id)
    if (c.mode === 'auto') {
      if (!startsOf(id, c).length) {
        add(id, 'error', `範圍 ${c.earliest}～${c.deadline} 放不下一次運轉（需要 ${n * 15} 分鐘`
          + `${HARD_END[id] ? `，且要在 ${hm(HARD_END[id])} 前跑完` : ''}）`)
      } else if (rangesOf(c.earliest, c.deadline).some(([a, b]) => {
        for (let s = a; s < b; s++) if (!inDefault(id, s)) return true
        return false
      })) {
        add(id, 'warn', `範圍超出建議範圍（${SHIFTABLE_RULES[id].text}），系統可能排在建議範圍外`)
      }
    } else if (c.mode === 'fixed') {
      const s = c.start
      if (s + n > (HARD_END[id] ?? SLOTS_PER_DAY)) add(id, 'error', `要在 ${hm(HARD_END[id])} 前跑完`)
      let outside = false
      for (let k = 0; k < n; k++) if (!inDefault(id, s + k)) outside = true
      if (outside) add(id, 'warn', `不在建議範圍（${SHIFTABLE_RULES[id].text}）`)
    }
  }
  // 先後：烘衣機要等洗衣機跑完
  const w = cond.washer
  const d = cond.dryer
  if (w.mode !== 'off' && d.mode !== 'off' && !pairStarts(cond).ok) {
    const dw = durOf('washer')
    add('dryer', 'error', w.mode === 'fixed' && d.mode === 'fixed'
      ? `要在洗衣機洗完（${hm(w.start + dw)}）之後才能開`
      : w.mode === 'fixed'
      ? `洗衣機 ${hm(w.start + dw)} 洗完後，來不及在 ${hm(HARD_END.dryer)} 前烘完`
      : d.mode === 'fixed'
      ? `指定的 ${hm(d.start)} 前，洗衣機來不及在範圍內洗完`
      : '洗衣機和烘衣機的範圍排不出「先洗再烘」')
  }
  return out
}
