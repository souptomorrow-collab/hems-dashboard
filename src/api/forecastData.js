/* ============================================================
   預測快照 — 資料讀取層

   ── 資料怎麼走到這裡 ──────────────────────────────
     [RF 隨機森林 / LSTM / 排程]  結果
          │  hems_db（第 2 版格式；連線字串只在各組本機，絕不進前端）
          ▼
     [MongoDB Atlas]  hems.load_forecast、actual_load、pv_forecast、actual_pv、schedule、meta  ← 唯一資料來源
          │  後端唯讀 API（hems-api，Vercel）
          ├──────────────▶ [HEMS UI] 平常直接讀 API
          │  scripts/export_snapshots.py（從 API 匯出，資料更新後手動執行）
          ▼
     public/data/forecast_day.json               夏月展示日（2010-09-06）  ← API 連不上時讀這些
     public/data/forecast_day_non_summer.json    非夏月展示日（2010-11-18）
     public/data/history.json                    歷史紀錄（一整年）
     public/data/schedule.json                   排程組的排程結果（hems.schedule）
     public/data/weather.json                    展示日期的台北 ERA5 天氣（scripts/fetch_weather.py，一律讀這份）
          ▼
     [HEMS UI]  主頁面預測圖 / 各負載 / 用電規劃 / 歷史紀錄

   ── 為什麼不像以前那樣直接打 API ──────────────────
   舊版是 Supabase，PostgREST 提供現成的 HTTP API，前端拿 anon key 直接查。
   MongoDB 沒有對應的東西：Atlas Data API 已於 2025-09-30 停止服務，
   只剩官方 driver（TCP + TLS + SCRAM），瀏覽器發不出這種連線；
   而 MongoDB 的連線字串是「一把全開的鑰匙」，沒有 Supabase anon key 那種
   唯讀權限層可以套，放進前端 bundle 等於把資料庫交出去。

   所以改成「發布快照」：資料庫仍是唯一來源，建置時匯出成靜態 JSON 一起部署。
   附帶好處是這條路比原本快也穩 —— 同源、免金鑰、沒有 CORS，
   也不會再遇到 Supabase 免費版冷啟動害前端逾時退回模擬值。

   代價：資料不是即時的，資料庫更新後要重跑匯出並重新部署。

   ── 後端 API（hems-api）────────────────────────────
   建置時若有設定 VITE_API_BASE（GitHub Actions 的 HEMS_API_BASE 變數），
   就先向後端 API 讀，回傳格式和快照完全相同；API 連不上或逾時才退回快照，
   所以 API 休眠、資料庫維護時展示也不會壞。天氣不在資料庫裡，一律讀快照。
   ============================================================ */

const ENV = import.meta.env ?? {}
const BASE = `${ENV.BASE_URL ?? '/'}data/`
const API_BASE = String(ENV.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 快照檔名 → API 路徑（hems-api 的端點） */
const API_PATHS = {
  'forecast_day.json': '/forecast/day?season=summer',
  'forecast_day_non_summer.json': '/forecast/day?season=non_summer',
  'history.json': '/history',
  'schedule.json': '/schedules',
}

/** 兩個情境各一份展示日快照（API 的 /forecast/day?season=summer、non_summer） */
const SHOWCASE_FILES = {
  summer: 'forecast_day.json',
  non_summer: 'forecast_day_non_summer.json',
}

/** 靜態檔理論上不會慢，但檔案不存在時不要讓 UI 一直轉圈 */
const TIMEOUT_MS = 5000
/** API 冷啟動要連資料庫，給寬一點；超過就改讀快照 */
const API_TIMEOUT_MS = 8000

async function fetchJson(url, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' })
    if (!r.ok) throw new Error(`讀取失敗 ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 讀一份資料。回傳的物件多一個 via 欄位：'api'（後端即時讀取）或 'snapshot'（靜態快照）。
 * @param {string} file 快照檔名
 */
export async function getJson(file) {
  const path = API_BASE && API_PATHS[file]
  if (path) {
    try {
      return { ...(await fetchJson(API_BASE + path, API_TIMEOUT_MS)), via: 'api' }
    } catch (e) {
      console.warn(`API 讀取 ${file} 失敗，改用快照：${e?.name === 'AbortError' ? '逾時' : e?.message}`)
    }
  }
  try {
    return { ...(await fetchJson(BASE + file, TIMEOUT_MS)), via: 'snapshot' }
  } catch (e) {
    throw new Error(`讀取 ${file} 失敗：${e?.name === 'AbortError' ? '逾時' : e?.message}`)
  }
}

/** 是否有設定後端 API（系統資訊頁顯示用） */
export const apiBase = API_BASE || null

/**
 * 取某個情境展示日的一日 96 格。
 *
 * slots 是匯出端把「當天 00:00 發布的那筆」攤成 0~95 格（第 0 格用真實值，見 hems-api 的 build_forecast_day），
 * 前端不再需要知道 lead_step 與 target_time 的對應規則。
 * 注意：這不是排程組用的前一天 23:45 日前預測；有排程時整日規劃改用排程裡的 load_kw（見 client.js）。
 *
 * @param {'summer'|'non_summer'} season
 */
export async function fetchDayAheadForecast(season = 'summer') {
  const d = await getJson(SHOWCASE_FILES[season] ?? SHOWCASE_FILES.summer)

  const slots = Array.isArray(d.slots) ? d.slots : null
  if (!slots || slots.length !== 96) {
    throw new Error(`預測快照格式不對（slots=${slots?.length ?? 'none'}）`)
  }
  return {
    season,
    slots: fillGaps(slots),
    // 當天真實值。有了它，「已經發生」的那段才是真的量測值，
    // 而不是把預測曲線切一段冒充。
    actual: Array.isArray(d.actual) ? d.actual : null,
    // rolling[s][k]＝第 s 格發布、領先 k+1 步的預測。
    // RF 每 15 分鐘重發一次未來 96 步，同一個時刻會被預測很多次、
    // 越接近越更新，這個矩陣就是拿來重現那個滾動行為的。
    rolling: Array.isArray(d.rolling) ? d.rolling : null,
    // 發電量（LSTM）：一天只發一次，所以只有一條日前曲線、沒有 rolling。
    // pvActual 是「以實測日射量換算」的發電量，不是實測出力。
    pv: Array.isArray(d.pv) && d.pv.length === 96 ? fillGaps(d.pv) : null,
    pvActual: Array.isArray(d.pv_actual) ? d.pv_actual : null,
    pvSource: typeof d.pv_source === 'string' ? d.pv_source : null,
    // 會直接顯示在畫面上，型別不對（例如變成物件）時 React 會整頁出錯，先擋掉
    targetDate: typeof d.target_date === 'string' ? d.target_date : null,
    hasActual: Boolean(d.has_actual),
    source: d.source ?? null,
    generatedAt: d.generated_at ?? null,
    via: d.via,
  }
}

/**
 * 展示日期的台北實際天氣（ERA5）。days 以資料集日期為鍵，
 * 每天是逐時的 temp / rh / cloud / precip / kt 陣列，轉換見 lib/weather.js 的 weatherFromEra5()。
 */
export async function fetchWeatherData() {
  const d = await getJson('weather.json')
  if (!d.days) throw new Error('天氣快照格式不對')
  return { source: d.source ?? null, days: d.days }
}

/**
 * 排程組的排程結果（MILP），來自 hems.schedule（API 的 /schedules；快照由 scripts/export_snapshots.py 匯出）。
 * 以排程日期（資料集日期）為鍵；每份 96 格：price、load_kw、pv_kw、pv_used_kw、grid_buy_kw、
 * batt_kw（正＝充電）、soc_pct（該格結束時）。
 * @returns {Promise<{source:string|null, generatedAt:string|null, byDate:Object<string,object>}>}
 */
export async function fetchSchedules() {
  const d = await getJson('schedule.json')
  const byDate = {}
  const nums = (a) => Array.isArray(a) && a.length === 96 && a.every(Number.isFinite)
  for (const s of Array.isArray(d.schedules) ? d.schedules : []) {
    // 欄位不齊的那份直接略過，電池改用模擬調度，不讓整頁出錯
    const ok = typeof s?.date === 'string'
      && ['price', 'load_kw', 'pv_kw', 'pv_used_kw', 'grid_buy_kw', 'batt_kw', 'soc_pct'].every((k) => nums(s[k]))
    if (ok) byDate[s.date] = s
  }
  return { source: d.source ?? null, generatedAt: d.generated_at ?? null, via: d.via, byDate }
}

/**
 * 補空格。正常情況下 96 格都有值（一次刷新剛好鋪滿一日），
 * 這裡只是保險：萬一某次刷新不完整，用前後鄰居內插，避免圖上斷線。
 * 首尾相接視為環狀，因為 0 與 95 在時間上是連續的。
 */
function fillGaps(slots) {
  const n = slots.length
  const out = slots.map((v) => (Number.isFinite(v) ? +Number(v).toFixed(3) : null))
  if (out.every((v) => v != null)) return out
  for (let s = 0; s < n; s++) {
    if (out[s] == null) {
      const prev = out[(s - 1 + n) % n]
      const next = out[(s + 1) % n]
      out[s] =
        prev != null && next != null
          ? +((prev + next) / 2).toFixed(3)
          : (prev ?? next ?? 0)
    }
  }
  return out
}

/* ------------------------------------------------------------
   快取：多個頁面/元件同時要資料時只讀一次
   ------------------------------------------------------------ */
const cache = new Map()

/** 讀取失敗後隔多久才重試。
 *  原本失敗就立刻刪掉快取：檔案不存在時，每 5 秒更新一次的即時畫面每次都重抓，console 一直洗出 404 */
const RETRY_MS = 60000

export function cached(key, loader) {
  if (!cache.has(key)) {
    const p = loader().catch((e) => {
      // 失敗不永久留著壞值，但先記住一分鐘再重試（只刪自己這一筆，免得刪到之後重建的）
      setTimeout(() => cache.get(key) === p && cache.delete(key), RETRY_MS)
      throw e
    })
    cache.set(key, p)
  }
  return cache.get(key)
}
