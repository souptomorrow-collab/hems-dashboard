/* ============================================================
   展示情境：夏月／非夏月

   交接資料有兩個情境（夏月 2010-07-19、非夏月 2010-01-11），而台電電價的
   尖離峰時段兩季不一樣。口試時要能兩種都展示，不必等到季節真的換了。

   切換的是「今天／明天」這幾頁（主頁面、各負載、用電規劃）用的資料：今天＝該情境的展示日
   （2010-07-19、2010-01-11），隔日＝展示日的下一天。負載、太陽能、天氣、排程、電價都取那一天
   （todayOf／nextDayOf），時分照畫面上的時鐘。不把真實日期換算成資料集的日期。
   畫面上的日期與時鐘照舊是真實時間；展示模式只是把時鐘加速、並顯示整月排程與實時運轉。
   歷史紀錄頁照每一天的實際日期算，不受影響。
   預設跟著今天的實際季節走，重新整理就回到預設。
   ============================================================ */
import { useSyncExternalStore } from 'react'
import { isSummer } from './tou.js'
import { nowTaipei } from './time.js'

// dataset：該情境用的資料集展示日（public/data 的快照，見 README.txt）
export const SEASONS = [
  { key: 'summer', label: '夏月', dataset: '2010-07-19', hint: '夏月情境（6/1～9/30）：平日尖峰 09:00–24:00' },
  { key: 'non_summer', label: '非夏月', dataset: '2010-01-11', hint: '非夏月情境（10/1～5/31）：平日尖峰 06:00–11:00、14:00–24:00' },
]

export const seasonOf = (date) => (isSummer(date) ? 'summer' : 'non_summer')

const pad = (n) => String(n).padStart(2, '0')
const ymdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`
const seasonInfo = (season) => SEASONS.find((x) => x.key === season) ?? SEASONS[0]

/** 某個情境的「今天」（資料集日期 'YYYY-MM-DD'）：展示日 */
export function todayOf(season) {
  return seasonInfo(season).dataset
}

/**
 * 某個情境可以調整的那一天（隔日）：展示日的下一天（2010-07-20、2010-01-12）。
 * 使用者只能改隔日的可轉移設備；存下後隔日以後重新排程，今天以前已經排好、跑過的不動。
 */
export function nextDayOf(season) {
  const [y, m, d] = todayOf(season).split('-').map(Number)
  const t = new Date(y, m - 1, d + 1)
  return ymdOf(t.getFullYear(), t.getMonth() + 1, t.getDate())
}

/** 畫面上的時刻換到資料集的今天：日期用展示日，時分照 now（展示模式下 now 已是虛擬時間）。
    電價照這個查，才和排程用的一致（真實日期是週末時也不會對不上） */
export function scenarioNow(now, season) {
  const [y, m, d] = todayOf(season).split('-').map(Number)
  const t = new Date(now)
  t.setFullYear(y, m - 1, d)
  return t
}

let state = { season: seasonOf(nowTaipei()) }
const listeners = new Set()

export function getScenario() {
  return state
}

export function setSeason(season) {
  if (season === state.season || !SEASONS.some((s) => s.key === season)) return
  state = { ...state, season }
  listeners.forEach((fn) => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useScenario() {
  return useSyncExternalStore(subscribe, getScenario, getScenario)
}

/**
 * 把日期換到指定季節：往前或往後挪整數週（星期幾不變，平日／週末的電價才不會跑掉），
 * 取離原日期最近、而且落在該季節的那天，時分保留。只拿來查電價，不顯示在畫面上。
 */
export function scenarioDate(date, season = state.season) {
  if (seasonOf(date) === season) return date
  for (let weeks = 1; weeks <= 53; weeks++) {
    for (const dir of [-1, 1]) {
      const d = new Date(date)
      d.setDate(d.getDate() + dir * 7 * weeks)
      if (seasonOf(d) === season) return d
    }
  }
  return date
}
