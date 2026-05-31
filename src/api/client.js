/* ============================================================
   資料存取層（API Client）

   目前：回傳本地「模擬資料」(simulate.js)。
   日後接後端：把每個函式內容換成 fetch() 即可，回傳格式不變，
   UI 端完全不用改。例如：

     const API_BASE = import.meta.env.VITE_API_BASE ?? ''
     export async function fetchLive() {
       const r = await fetch(`${API_BASE}/api/live`)
       return r.json()
     }

   所有函式都回傳 Promise，並刻意加上極短延遲模擬網路，
   讓 UI 的載入狀態(loading)邏輯能被測到。
   ============================================================ */
import { liveSnapshot, simulateDay, simulateWithSchedule } from '../lib/simulate.js'
import { tomorrow } from '../lib/format.js'

const delay = (ms) => new Promise((res) => setTimeout(res, ms))

/** 主頁面即時快照（太陽能/電池/負載/電網/SOC/省電費…） */
export async function fetchLive(now = new Date()) {
  await delay(120)
  return liveSnapshot(now)
}

/** 今日整日模擬（主頁面的 24h 趨勢圖、最佳化結果） */
export async function fetchToday(now = new Date(), mode = 'cost') {
  await delay(150)
  return simulateDay(now, mode)
}

/** 隔日預測 + 最佳化排程（主頁面「預測結果」、頁面三規劃） */
export async function fetchPlanning(mode = 'cost', baseDate = new Date()) {
  await delay(220)
  return simulateDay(tomorrow(baseDate), mode)
}

/**
 * 重新執行最佳化（頁面三的「重新計算」按鈕）。
 * 後端版本會在此觸發 GA 重新排程；這裡用同一個模擬引擎並切換模式。
 */
export async function runOptimization(mode = 'cost', baseDate = new Date()) {
  await delay(650) // 模擬演算法計算時間
  return simulateDay(tomorrow(baseDate), mode)
}

/**
 * 依使用者手動調整後的排程重新計算電池調度與成本（不重跑 GA）。
 * @param {object} schedule  { deviceId: boolean[96] }
 */
export async function recomputeSchedule(schedule, mode = 'cost', baseDate = new Date()) {
  await delay(120)
  return simulateWithSchedule(tomorrow(baseDate), mode, schedule)
}
