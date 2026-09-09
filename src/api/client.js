/* ============================================================
   資料存取層（API Client）

   ── 目前的接線狀況 ──────────────────────────────
   家庭負載（不可轉移）：**已接真實資料**。
     RF 隨機森林預測結果存在 Supabase（PostgreSQL）的 load_forecast 表，
     本檔透過 PostgREST 取最新 refresh 的 96 步，覆蓋掉模擬的不可轉移負載。
     雲端連不上時自動退回模擬值，UI 不會壞掉（badge 會標示資料來源）。

   太陽能發電（LSTM）、GA 排程：仍為模擬引擎（simulate.js）。
     之後接後端時，把對應函式內容換成 fetch() 即可，回傳格式不變。

   所有函式都回傳 Promise。
   ============================================================ */
import { liveSnapshot, simulateDay, simulateWithSchedule } from '../lib/simulate.js'
import { tomorrow } from '../lib/format.js'
import { nowTaipei } from '../lib/time.js'
import { simulateWeather } from '../lib/weather.js'
import { fetchDayAheadForecast } from './supabase.js'
import { forecastToSlots, cached } from '../lib/loadForecast.js'

const delay = (ms) => new Promise((res) => setTimeout(res, ms))

/* ------------------------------------------------------------
   不可轉移負載：取雲端「23:45 發布」那筆 96 步預測，整成 96 格陣列。
   整個 app 只打一次 API（快取），失敗回 null → 各函式自動用模擬值。

   ★ 時間軸的處理 ★
   預測資料的時間戳是資料集本身的日期（UCI household_power_consumption，
   2010 年 11 月的法國 Sceaux 住宅），而 UI 顯示的是當下的今日／明日。
   這裡是**依「一日中的時段」(0~95) 對齊**，不做日期換算：
   曲線形狀完全是 RF 的真實輸出，只是掛在畫面當天的日期標籤下。
   實際部署接上即時資料後，日期自然就會對上，這層對齊可以直接拿掉。
   ------------------------------------------------------------ */
let lastForecastMeta = {
  source: 'sim',
  refresh: null,
  datasetDate: null,
  error: null,
}

async function realFixedLoad() {
  try {
    const { refresh, rows, targetDate } = await cached(
      'day-ahead-forecast',
      fetchDayAheadForecast
    )
    const slots = forecastToSlots(rows)
    if (!slots) throw new Error('雲端無預測資料')
    lastForecastMeta = { source: 'rf', refresh, datasetDate: targetDate, error: null }
    return slots
  } catch (e) {
    lastForecastMeta = { source: 'sim', refresh: null, datasetDate: null, error: e.message }
    if (import.meta.env.DEV) console.warn('[HEMS] 取雲端負載預測失敗，改用模擬值：', e.message)
    return null
  }
}

/**
 * 目前負載資料的來源（UI 標示用）。
 * @returns {{source:'rf'|'sim', refresh:string|null, datasetDate:string|null, error:string|null}}
 */
export function loadForecastMeta() {
  return lastForecastMeta
}

/** 主頁面即時快照（太陽能/電池/負載/電網/SOC/省電費…） */
export async function fetchLive(now = nowTaipei()) {
  const fixed = await realFixedLoad()
  await delay(60)
  return liveSnapshot(now, fixed)
}

/** 今日整日（主頁面的 24h 趨勢圖、最佳化結果） */
export async function fetchToday(now = nowTaipei(), mode = 'cost') {
  const fixed = await realFixedLoad()
  await delay(80)
  return simulateDay(now, mode, simulateWeather(now), fixed)
}

/** 隔日預測 + 最佳化排程（主頁面「預測結果」、頁面三規劃） */
export async function fetchPlanning(mode = 'cost', baseDate = nowTaipei()) {
  const fixed = await realFixedLoad()
  const date = tomorrow(baseDate)
  await delay(120)
  return simulateDay(date, mode, simulateWeather(date), fixed)
}

/**
 * 重新執行最佳化（頁面三的「重新計算」按鈕）。
 * 後端版本會在此觸發 GA 重新排程；這裡用同一個模擬引擎並切換模式，
 * 但不可轉移負載仍是真實的 RF 預測。
 */
export async function runOptimization(mode = 'cost', baseDate = nowTaipei()) {
  const fixed = await realFixedLoad()
  const date = tomorrow(baseDate)
  await delay(650) // 模擬演算法計算時間
  return simulateDay(date, mode, simulateWeather(date), fixed)
}

/**
 * 依使用者手動調整後的排程重新計算電池調度與成本（不重跑 GA）。
 * @param {object} schedule  { deviceId: boolean[96] }
 */
export async function recomputeSchedule(schedule, mode = 'cost', baseDate = nowTaipei()) {
  const fixed = await realFixedLoad()
  const date = tomorrow(baseDate)
  await delay(60)
  return simulateWithSchedule(date, mode, schedule, simulateWeather(date), fixed)
}

/**
 * 取得某日台北天氣（餵給太陽能/負載預測）。
 *
 * 目前回傳「模擬天氣」。真實系統建議由 Python 後端整合：
 *   1) 後端以 CWA（中央氣象署）開放資料 API 取得台北實際/預報天氣
 *      （需免費金鑰；瀏覽器直接呼叫多會被 CORS 擋，故放後端）
 *   2) 把日照／溫度／濕度餵入 LSTM（太陽能）、RF（負載）模型
 *   3) 後端把天氣 + 預測結果一起回傳，前端只負責顯示
 * 屆時改成：const r = await fetch(`${API_BASE}/api/weather?date=...`); return r.json()
 * 回傳格式比照 src/lib/weather.js 的 simulateWeather() 輸出。
 */
export async function fetchWeather(date = tomorrow(nowTaipei())) {
  await delay(120)
  return simulateWeather(date)
}
