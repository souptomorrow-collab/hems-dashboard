/* ============================================================
   展示模式（加速播放）

   期末展示時沒辦法真的站在台上等一天，所以把一天壓縮成 96 秒播完：
   排程的解析度是 15 分鐘、一天 96 格，**一格對應一秒**。

   做法是「換掉時鐘」而不是另外寫一套模擬：整個 UI 的即時畫面本來就
   由 useClock() 給的時間推導（liveSnapshot(now) 依 now 算出目前在第幾格，
   再取該格的排程、發電、電池狀態），所以只要讓時鐘回傳虛擬時間，
   能源流向、KPI 卡、尖離峰標示、設備開關狀態就會全部跟著跑，
   不會有「展示用的假畫面」和「真的畫面」兩套邏輯需要同步。

   日期沿用今天，只換時分——電價的夏月/非夏月、平日/假日判斷才不會跑掉。
   ============================================================ */
import { useSyncExternalStore } from 'react'
import { SLOTS_PER_DAY } from './constants.js'
import { nowTaipei } from './time.js'

/** 速度選項：一格（15 分鐘）要播幾毫秒 */
export const SPEEDS = [
  { key: 1, label: '1×', ms: 1000, hint: '15 分鐘 = 1 秒，一天 96 秒' },
  { key: 2, label: '2×', ms: 500, hint: '一天 48 秒' },
  { key: 4, label: '4×', ms: 250, hint: '一天 24 秒' },
]

let state = { enabled: false, playing: false, slot: 0, speed: 1 }
const listeners = new Set()
let timer = null

function emit() {
  state = { ...state } // useSyncExternalStore 靠參考變化判斷更新
  listeners.forEach((fn) => fn())
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  const ms = SPEEDS.find((s) => s.key === state.speed)?.ms ?? 1000
  timer = setInterval(() => {
    // 播到 23:45 就繞回 00:00：展示時通常會讓它一直循環播
    state.slot = (state.slot + 1) % SLOTS_PER_DAY
    emit()
  }, ms)
}

export function getDemo() {
  return state
}

/** 開啟展示模式並從 00:00 開始播 */
export function startDemo() {
  state.enabled = true
  state.playing = true
  state.slot = 0
  startTimer()
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

/** 暫停／繼續（維持在展示模式，只是不再前進） */
export function togglePlay() {
  if (!state.enabled) return
  state.playing = !state.playing
  state.playing ? startTimer() : stopTimer()
  emit()
}

/** 拖進度條直接跳到某一格 */
export function seekDemo(slot) {
  if (!state.enabled) return
  state.slot = Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.round(slot)))
  emit()
}

export function setSpeed(speed) {
  state.speed = speed
  if (state.enabled && state.playing) startTimer()
  emit()
}

/** 回到 00:00 重播 */
export function restartDemo() {
  state.slot = 0
  if (state.enabled && !state.playing) togglePlay()
  emit()
}

/**
 * 目前這一格對應的時間。
 * 日期沿用今天，只換時分——電價的夏月／平日假日判斷要靠日期，不能亂動。
 */
export function slotToDate(slot, base = nowTaipei()) {
  const d = new Date(base)
  d.setHours(Math.floor(slot / 4), (slot % 4) * 15, 0, 0)
  return d
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDemoClock() {
  return useSyncExternalStore(subscribe, getDemo, getDemo)
}
