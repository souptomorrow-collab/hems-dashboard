/* ============================================================
   資料存取層（API Client）

   ── 目前的接線狀況 ──────────────────────────────
   家庭負載（不可轉移）：**已接真實資料**。
     RF 隨機森林預測結果存在 MongoDB Atlas 的 hems.load_forecast，
     建置時由 mongo_handoff/04_export_web.py 匯出成靜態快照一起部署，
     本檔讀那份快照，覆蓋掉模擬的不可轉移負載（詳見 api/forecastData.js）。
     讀不到時自動退回模擬值，UI 不會壞掉（badge 會標示資料來源）。

   太陽能發電（LSTM）、GA 排程：仍為模擬引擎（simulate.js）。
     之後接後端時，把對應函式內容換成 fetch() 即可，回傳格式不變。

   所有函式都回傳 Promise。
   ============================================================ */
import { liveSnapshot, simulateDay, simulateWithSchedule } from '../lib/simulate.js'
import { tomorrow } from '../lib/format.js'
import { nowTaipei } from '../lib/time.js'
import { simulateWeather } from '../lib/weather.js'
import { fetchDayAheadForecast, cached } from './forecastData.js'

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

/**
 * 組出「站在第 atSlot 格往後看」的一日 96 格不可轉移負載。
 *
 *   過去（0..atSlot）  用當天真實值
 *   未來（atSlot+1..） 用「在第 atSlot 格發布」的那次預測
 *
 * 這才是 RF 實際的產出方式：它每 15 分鐘重跑一次、重發未來 96 步，
 * 同一個時刻會被預測很多次，越接近越更新。原本 UI 只取一筆當成整天的
 * 固定曲線，等於把滾動預測畫成靜態預測。
 *
 * atSlot 給 null 就退回整日曲線（例如頁面三的隔日規劃，那時還沒有真實值）。
 */
function assembleFixed(d, atSlot) {
  if (atSlot == null || !d.rolling) return d.slots
  const s = Math.max(0, Math.min(95, atSlot))
  const fc = d.rolling[s]
  const out = new Array(96)
  for (let i = 0; i < 96; i++) {
    if (i <= s) out[i] = d.actual?.[i] ?? d.slots[i]
    else out[i] = fc ? (fc[i - s - 1] ?? d.slots[i]) : d.slots[i]
  }
  return out
}

async function realFixedLoad(atSlot = null) {
  try {
    const d = await cached('day-ahead-forecast', fetchDayAheadForecast)
    if (!d.slots) throw new Error('快照無預測資料')
    lastForecastMeta = {
      source: 'rf',
      refresh: atSlot == null ? null : `第 ${atSlot + 1} / 96 格發布`,
      datasetDate: d.targetDate,
      rolling: Boolean(d.rolling),
      error: null,
    }
    return assembleFixed(d, atSlot)
  } catch (e) {
    lastForecastMeta = { source: 'sim', refresh: null, datasetDate: null, error: e.message }
    if (import.meta.env.DEV) console.warn('[HEMS] 取雲端負載預測失敗，改用模擬值：', e.message)
    return null
  }
}

/**
 * 滾動預測的原始資料（真實值 + 96×96 的發布矩陣），給「滾動預測」那張圖用。
 *
 * 其他圖拿到的是已經組好的單一條負載曲線，看不出滾動；
 * 這張圖要把「不同時間點發布的預測」並排畫出來，所以需要整個矩陣。
 * 讀不到時回 null，那張圖就不顯示。
 */
export async function fetchRollingForecast() {
  try {
    const d = await cached('day-ahead-forecast', fetchDayAheadForecast)
    if (!d.rolling || !d.actual) return null
    return { rolling: d.rolling, actual: d.actual, targetDate: d.targetDate }
  } catch {
    return null
  }
}

/**
 * 歷史紀錄：逐日的真實值、日前預測、一步預測（public/data/history.json）。
 * 和其他資料一樣是由 MongoDB 匯出的靜態快照，見 mongo_handoff/04_export_web.py。
 * @returns {Promise<{days:Array, source:string, generatedAt:string}|null>}
 */
export async function fetchHistory() {
  return cached('history', async () => {
    const r = await fetch(`${import.meta.env.BASE_URL}data/history.json`, { cache: 'no-cache' })
    if (!r.ok) throw new Error(`讀取歷史紀錄失敗 ${r.status}`)
    const d = await r.json()
    return { days: d.days ?? [], source: d.source ?? null, generatedAt: d.generated_at ?? null }
  }).catch(() => null)
}

/**
 * 用某一天的「真實」不可轉移負載跑一次 HEMS 模擬，得到那天的運轉紀錄。
 * 太陽能與排程目前仍是模擬引擎，所以這部分是「如果那天由本系統運轉會怎樣」，
 * 不是量測紀錄；頁面上會標明。
 */
export function simulateHistoryDay(dateStr, actualKw) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return simulateDay(date, simulateWeather(date), actualKw)
}

/**
 * 目前負載資料的來源（UI 標示用）。
 * @returns {{source:'rf'|'sim', refresh:string|null, datasetDate:string|null, error:string|null}}
 */
export function loadForecastMeta() {
  return lastForecastMeta
}

/** 主頁面即時快照（太陽能/電池/負載/電網/SOC/省電費…） */
export async function fetchLive(now = nowTaipei(), atSlot = null) {
  const fixed = await realFixedLoad(atSlot)
  await delay(60)
  return liveSnapshot(now, fixed)
}

/** 今日整日（主頁面的 24h 趨勢圖、最佳化結果） */
export async function fetchToday(now = nowTaipei(), atSlot = null) {
  const fixed = await realFixedLoad(atSlot)
  await delay(80)
  return simulateDay(now, simulateWeather(now), fixed)
}

/** 隔日預測 + 最佳化排程（主頁面「預測結果」、頁面三規劃） */
export async function fetchPlanning(baseDate = nowTaipei()) {
  const fixed = await realFixedLoad()
  const date = tomorrow(baseDate)
  await delay(120)
  return simulateDay(date, simulateWeather(date), fixed)
}

/**
 * 重新執行最佳化（頁面三的「重新計算」按鈕）。
 * 後端版本會在此觸發 GA 重新排程；這裡用同一個模擬引擎並切換模式，
 * 但不可轉移負載仍是真實的 RF 預測。
 */
export async function runOptimization(baseDate = nowTaipei()) {
  const fixed = await realFixedLoad()
  const date = tomorrow(baseDate)
  await delay(650) // 模擬演算法計算時間
  return simulateDay(date, simulateWeather(date), fixed)
}

/**
 * 依使用者手動調整後的排程重新計算電池調度與成本（不重跑 GA）。
 * @param {object} schedule  { deviceId: boolean[96] }
 */
export async function recomputeSchedule(schedule, baseDate = nowTaipei()) {
  const fixed = await realFixedLoad()
  const date = tomorrow(baseDate)
  await delay(60)
  return simulateWithSchedule(date, schedule, simulateWeather(date), fixed)
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
