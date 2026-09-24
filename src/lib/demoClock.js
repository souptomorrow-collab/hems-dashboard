/* ============================================================
   展示模式（加速播放）

   期末展示時沒辦法真的站在台上等一天，所以把時間加速播放。
   時鐘以「秒」為單位前進，速度可以選：
     15 分鐘 = 1 秒（預設）  一天 96 秒，看排程一整天的運作
     1 分鐘 = 1 秒           一格 15 秒，看得到實時層逐秒怎麼跟著實際負載修正（秒級重播跟著這個時鐘走）
   15 分鐘＝1 秒時，一格裡 900 秒的實時控制被擠進 1 秒，只看得到 15 分鐘平均；
   要講實時層就切到慢速。

   做法是「換掉時鐘」而不是另外寫一套模擬：整個 UI 的即時畫面本來就
   由 useClock() 給的時間推導（liveSnapshot(now) 依 now 算出目前在第幾格，
   再取該格的排程、發電、電池狀態），所以只要讓時鐘回傳虛擬時間，
   能源流向、KPI 卡、尖離峰標示、設備開關狀態就會全部跟著跑，
   不會有「展示用的假畫面」和「真的畫面」兩套邏輯需要同步。

   播放整個展示月：從月初 00:00 開始，播到 23:59:59 就進到下一天，播完最後一天就停；
   停在月底時再按繼續（▶ 或空白鍵）就從月初重播。
   day 是月內第幾天（0 起），日期由 scenario.js 的 todayOf() 換成資料集日期；
   今天跟著播放走，用電規劃能調整的隔日也跟著走。

   訂閱：時鐘每 0.1 秒前進一次。只需要「開沒開」或「第幾格」的元件用 useDemoEnabled／useDemoSlot，
   值有變才重畫；要逐秒的（頁首時鐘、秒級重播、控制列）才用 useDemoClock。
   ============================================================ */
import { useSyncExternalStore } from 'react'
import { SLOTS_PER_DAY } from './constants.js'
import { nowTaipei } from './time.js'

const DAY_S = 86400
const SLOT_S = DAY_S / SLOTS_PER_DAY // 900
const TICK_MS = 100

/** 速度選項：key＝真實 1 秒播幾秒 */
export const SPEEDS = [
  { key: 60, label: '1 分/秒', hint: '1 分鐘 = 1 秒：一格 15 秒、一天 24 分鐘，看得到實時層逐秒控制' },
  { key: 300, label: '5 分/秒', hint: '5 分鐘 = 1 秒：一格 3 秒、一天約 5 分鐘' },
  { key: 900, label: '15 分/秒', hint: '15 分鐘 = 1 秒：一天 96 秒，看排程一整天的運作' },
  { key: 3600, label: '1 時/秒', hint: '1 小時 = 1 秒：一天 24 秒' },
  { key: 8640, label: '1 天/10 秒', hint: '一天 10 秒：整個月約 5 分鐘播完' },
]
const DEFAULT_SPEED = 900

let state = { enabled: false, playing: false, day: 0, days: 31, sec: 0, slot: 0, speed: DEFAULT_SPEED }
const listeners = new Set()
let timer = null
let carry = 0 // 不足 1 秒的餘數，換速度時不會跳動

function emit() {
  state = { ...state } // useSyncExternalStore 靠參考變化判斷更新
  listeners.forEach((fn) => fn())
}

/** 設定「從今天 00:00 起的第幾秒」：超過一天就進到下一天、小於 0 就回前一天；播完最後一天就停在月底 */
function setSec(s) {
  s = Math.floor(s)
  let day = state.day + Math.floor(s / DAY_S)
  let sec = ((s % DAY_S) + DAY_S) % DAY_S
  if (day >= state.days) {
    day = state.days - 1
    sec = DAY_S - 1
    state.playing = false
    stopTimer()
  } else if (day < 0) {
    day = 0
    sec = 0
  }
  state.day = day
  state.sec = sec
  state.slot = Math.floor(sec / SLOT_S)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  carry = 0
  let last = performance.now()
  timer = setInterval(() => {
    // 用實際經過的時間算，分頁在背景被瀏覽器放慢時，回來也不會越播越慢
    const t = performance.now()
    carry += ((t - last) / 1000) * state.speed
    last = t
    const step = Math.floor(carry)
    if (!step) return
    carry -= step
    setSec(state.sec + step)
    emit()
  }, TICK_MS)
}

export function getDemo() {
  return state
}

/** 開啟展示模式：從月初（第 day 天）00:00 開始。days＝這個月有幾天；play＝要不要馬上開始播 */
export function startDemo({ days = 31, day = 0, play = true } = {}) {
  state.enabled = true
  state.days = days
  state.day = Math.max(0, Math.min(days - 1, day))
  setSec(0)
  state.playing = play
  play ? startTimer() : stopTimer()
  emit()
}

/** 關閉展示模式，畫面回到真實時間 */
export function stopDemo() {
  stopTimer()
  state.enabled = false
  state.playing = false
  emit()
}

export function toggleDemo() {
  state.enabled ? stopDemo() : startDemo()
}

/** 已經播到月底最後一秒（播完自動停下的位置） */
export function atMonthEnd(s = state) {
  return s.day >= s.days - 1 && s.sec >= DAY_S - 1
}

/** 暫停／繼續（維持在展示模式，只是不再前進）。
    播完整個月停在月底時按繼續，從月初重播：原本照樣開始計時，下一格又碰到月底馬上停，看起來像按了沒反應 */
export function togglePlay() {
  if (!state.enabled) return
  if (!state.playing && atMonthEnd()) {
    state.day = 0
    setSec(0)
  }
  state.playing = !state.playing
  state.playing ? startTimer() : stopTimer()
  emit()
}

/** 拖進度條直接跳到今天的某一格（該格的開頭）。
    鍵盤 ← → 會要求超出今天的格子（23:59 按 →、00:05 按 ←）：夾回範圍後還是同一格就不動，
    原本會跳回那一格的開頭，時間反而往回走 */
export function seekDemo(slot) {
  if (!state.enabled) return
  const want = Math.round(slot)
  const to = Math.max(0, Math.min(SLOTS_PER_DAY - 1, want))
  if (to !== want && to === state.slot) return
  setSec(to * SLOT_S)
  emit()
}

/** 跳到月內第幾天（0 起）的 00:00。
    超出展示月（月底按 PageDown、月初按 PageUp）就維持不動，不要把時間重設到當天 00:00 */
export function seekDemoDay(day) {
  if (!state.enabled) return
  const want = Math.round(day)
  const to = Math.max(0, Math.min(state.days - 1, want))
  if (to !== want && to === state.day) return
  state.day = to
  setSec(0)
  emit()
}

/** 跳到一天中的第幾秒（秒級重播拖進度條用） */
export function seekDemoSec(sec) {
  if (!state.enabled) return
  setSec(Math.max(0, Math.min(DAY_S - 1, sec)))
  emit()
}

export function setSpeed(speed) {
  state.speed = speed
  if (state.enabled && state.playing) startTimer()
  emit()
}

/** 回到月初 00:00 重播 */
export function restartDemo() {
  state.day = 0
  setSec(0)
  if (state.enabled && !state.playing) togglePlay()
  emit()
}

/**
 * 某一格開頭對應的時間。
 * 日期沿用今天，只換時分——電價的夏月／平日假日判斷要靠日期，不能亂動。
 */
export function slotToDate(slot, base = nowTaipei()) {
  const d = new Date(base)
  d.setHours(Math.floor(slot / 4), (slot % 4) * 15, 0, 0)
  return d
}

/** 一天中的第幾秒對應的時間（日期沿用今天） */
export function secToDate(sec, base = nowTaipei()) {
  const d = new Date(base)
  d.setHours(Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60, 0)
  return d
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 整個時鐘狀態（每 0.1 秒更新一次；只要開關或格數的元件請用下面兩個） */
export function useDemoClock() {
  return useSyncExternalStore(subscribe, getDemo, getDemo)
}

const enabledOf = () => state.enabled
const slotOf = () => (state.enabled ? state.slot : -1)
const dayOf = () => (state.enabled ? state.day : -1)

/** 只關心展示模式開或關（播放中每前進一秒不必重畫整頁） */
export function useDemoEnabled() {
  return useSyncExternalStore(subscribe, enabledOf, enabledOf)
}

/** 展示模式下播到第幾格（沒開是 -1）；進到下一格才重畫 */
export function useDemoSlot() {
  return useSyncExternalStore(subscribe, slotOf, slotOf)
}

/** 展示模式下播到月內第幾天（0 起，沒開是 -1）；換天才重畫 */
export function useDemoDay() {
  return useSyncExternalStore(subscribe, dayOf, dayOf)
}
