/* 可轉移設備排出來的時段合不合理。

   使用者自己決定設備什麼時候跑，所以這裡只檢查「拖出來的結果本身說不通」的情形，
   不替使用者改動時段。不允許運轉的時段由 isAllowedSlot 在拖曳當下就擋掉了，不在這裡。

   error  這樣跑不起來：時數不對、一次運轉被拆成好幾段、順序顛倒
   warn   可能是故意的：多台擠在同一時間（瞬時功率疊加） */
import { DEVICES, SLOTS_PER_DAY, slotToTime } from './constants.js'
import { SHIFTABLE_RULES } from './simulate.js'

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')
const nameOf = (id) => DEVICES.find((d) => d.id === id)?.name ?? id

/** 96 格 true/false → 連續段的格號 [[起, 迄), …] */
export function spansOf(row) {
  if (!Array.isArray(row)) return []
  const out = []
  let start = null
  for (let i = 0; i <= SLOTS_PER_DAY; i++) {
    if (row[i] && start === null) start = i
    else if (!row[i] && start !== null) { out.push([start, i]); start = null }
  }
  return out
}

/** 某一台的問題。沒排不算問題——沒排就是不跑。 */
export function checkDevice(devId, schedule) {
  const row = schedule?.[devId]
  const rule = SHIFTABLE_RULES[devId]
  const spans = spansOf(row)
  if (!rule || !spans.length) return []

  const out = []
  const total = spans.reduce((n, [a, b]) => n + (b - a), 0)
  if (total !== rule.dur) {
    out.push({
      level: 'error',
      text: `共 ${total * 15} 分鐘，這台需要 ${rule.dur * 15} 分鐘`,
    })
  }
  if (spans.length > 1) {
    out.push({ level: 'error', text: `分成 ${spans.length} 段，這台要一次跑完` })
  }
  if (rule.after) {
    const prev = spansOf(schedule?.[rule.after])
    const prevEnd = prev.length ? prev[prev.length - 1][1] : null
    if (prevEnd !== null && spans[0][0] < prevEnd) {
      out.push({
        level: 'error',
        text: `要排在${nameOf(rule.after)}跑完（${slotToTime(prevEnd)}）之後`,
      })
    }
  }
  const clash = SHIFTABLE
    .filter((d) => d.id !== devId && Array.isArray(schedule?.[d.id]))
    .filter((d) => row.some((v, i) => v && schedule[d.id][i]))
    .map((d) => d.name)
  if (clash.length) {
    out.push({ level: 'warn', text: `和${clash.join('、')}同時運轉` })
  }
  return out
}

/** 三台的問題彙總，照設備順序。 */
export function checkAll(schedule) {
  return SHIFTABLE.flatMap((d) =>
    checkDevice(d.id, schedule).map((p) => ({ ...p, devId: d.id, device: d.name })))
}
