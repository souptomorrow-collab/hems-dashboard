/* ============================================================
   展示情境：夏月／非夏月

   交接資料有兩個情境（夏月 2010-07-19、非夏月 2010-01-11），而台電電價的
   尖離峰時段兩季不一樣。口試時要能兩種都展示，不必等到季節真的換了。

   切換的是「今天／明天」這幾頁（主頁面、各負載、用電規劃）用的資料。負載、太陽能、天氣、排程、電價
   都取「今天」那一天（todayOf），隔日是它的下一天（nextDayOf），時分照畫面上的時鐘：
     - 平常：日期與時鐘就是今天，負載、太陽能、天氣、電池、可轉移設備全部用模擬的
       （切到另一季時，電價用 scenarioDate() 換到該季節裡星期幾相同的日期去查）
     - 展示模式：換成專題的實際資料。從月初一天一天播完展示月（2010 年 7 月、1 月），
       今天＝播放中的那一天，能調整的隔日也跟著走；頁首顯示資料集的日期，頁面最下方顯示整月排程與實時運轉
   歷史紀錄頁照每一天的實際日期算，不受影響。
   預設跟著今天的實際季節走，重新整理就回到預設。
   ============================================================ */
import { useMemo, useSyncExternalStore } from 'react'
import { isSummer } from './tou.js'
import { nowTaipei } from './time.js'
import { getDemo, useDemoEnabled, useDemoDay } from './demoClock.js'

// dataset：該情境用的資料集展示日（public/data 的快照，見 README.txt）
export const SEASONS = [
  { key: 'summer', label: '夏月', dataset: '2010-07-19', hint: '夏月情境（6/1～9/30）：平日尖峰 09:00–24:00' },
  { key: 'non_summer', label: '非夏月', dataset: '2010-01-11', hint: '非夏月情境（10/1～5/31）：平日尖峰 06:00–11:00、14:00–24:00' },
]

export const seasonOf = (date) => (isSummer(date) ? 'summer' : 'non_summer')

const pad = (n) => String(n).padStart(2, '0')
const ymdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`
const seasonInfo = (season) => SEASONS.find((x) => x.key === season) ?? SEASONS[0]

/** 展示月有幾天 */
export function monthLengthOf(season) {
  const [y, m] = seasonInfo(season).dataset.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

const ymdNow = (d) => ymdOf(d.getFullYear(), d.getMonth() + 1, d.getDate())

/** 某個情境的「今天」（'YYYY-MM-DD'）：平常＝真實的今天；展示模式＝播放中的那一天（資料集日期） */
export function todayOf(season, demo = getDemo()) {
  const s = seasonInfo(season)
  if (!demo.enabled) return ymdNow(nowTaipei())
  const [y, m] = s.dataset.split('-').map(Number)
  return ymdOf(y, m, Math.min(monthLengthOf(season), demo.day + 1))
}

/**
 * 某個情境可以調整的那一天（隔日）：今天的下一天。平常是真實的明天；展示模式是播放中那天的下一天。
 * 使用者只能改隔日的可轉移設備；存下後隔日以後重新排程，今天以前已經排好、跑過的不動。
 * 展示模式播到月底時沒有隔日，回傳 null。
 */
export function nextDayOf(season, demo = getDemo()) {
  const [y, m, d] = todayOf(season, demo).split('-').map(Number)
  if (!demo.enabled) return ymdNow(new Date(y, m - 1, d + 1))
  return d < monthLengthOf(season) ? ymdOf(y, m, d + 1) : null
}

/** 查電價用的時刻。展示模式：日期換成播放中的資料集日期、時分照 now（和排程用的一致）；
    平常：就是今天，切到另一季時換到該季節裡星期幾相同的日期（scenarioDate） */
export function scenarioNow(now, season) {
  if (!getDemo().enabled) return scenarioDate(now, season)
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

/** React 元件用：目前情境的今天與隔日（展示模式換天時跟著更新；隔日在月底是 null） */
export function useScenarioDays() {
  const { season } = useScenario()
  const enabled = useDemoEnabled()
  const day = useDemoDay()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ today: todayOf(season), next: nextDayOf(season) }), [season, enabled, day])
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
