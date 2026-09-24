/* ============================================================
   展示情境：夏月／非夏月

   交接資料有兩個情境（夏月 2010-07-19、非夏月 2010-01-11），而台電電價的
   尖離峰時段兩季不一樣。口試時要能兩種都展示，不必等到季節真的換了。

   兩種模式看的是同一份資料（專題的實際資料：實時運轉紀錄、每 15 分鐘重排的計畫、日前排程），
   日期都換成展示月（2010 年 7 月、1 月）的日子；負載、太陽能、天氣、排程、電價都取「今天」那一天（todayOf），
   隔日是它的下一天（nextDayOf），時分照畫面上的時鐘：
     - 平常：一直看夏月的 7 月，真實時間每過一天就往下一天，7/31 之後接回 7/1（循環），時分就是現在
             （以 2026/9/1 對到 7/1：9/24 15:21 → 2010-07-24 15:21、10/1 → 7/31、10/2 → 7/1）
     - 展示模式：同一個月的加速版，從月初一天一天播完，今天＝播放中的那一天；管理員可以切到非夏月（1 月）
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

// 平常模式的循環起點：這一天對到展示月 1 號，之後每過一天往下一天，滿一個月接回 1 號
const CYCLE_START = new Date(2026, 8, 1)

/** 平常模式今天是展示月的第幾天（0 起） */
function cycleDay(season, now = nowTaipei()) {
  const len = monthLengthOf(season)
  const n = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - CYCLE_START) / 86400000)
  return ((n % len) + len) % len
}

/** 某個情境的「今天」（'YYYY-MM-DD'，展示月的日子）：平常＝循環到的那一天；展示模式＝播放中的那一天 */
export function todayOf(season, demo = getDemo()) {
  const [y, m] = seasonInfo(season).dataset.split('-').map(Number)
  return ymdOf(y, m, (demo.enabled ? demo.day : cycleDay(season)) + 1)
}

/**
 * 某個情境可以調整的那一天（隔日）：今天的下一天。
 * 使用者只能改隔日的可轉移設備；存下後隔日以後重新排程，今天以前已經排好、跑過的不動。
 * 今天是月底時回傳 null：平常模式的下一天雖然接回 1 號，但重排只能從今天往後排，1 號在今天之前。
 */
export function nextDayOf(season, demo = getDemo()) {
  const [y, m, d] = todayOf(season, demo).split('-').map(Number)
  return d < monthLengthOf(season) ? ymdOf(y, m, d + 1) : null
}

/** 查電價用的時刻：日期換成「今天」（展示月的日子），時分照 now（和排程用的一致） */
export function scenarioNow(now, season) {
  const [y, m, d] = todayOf(season).split('-').map(Number)
  const t = new Date(now)
  t.setFullYear(y, m - 1, d)
  return t
}

// 平常一律看夏月（7 月）；管理員在展示模式才切得到非夏月
export const DEFAULT_SEASON = 'summer'
let state = { season: DEFAULT_SEASON }
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
