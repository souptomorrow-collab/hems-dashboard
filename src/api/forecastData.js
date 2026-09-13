/* ============================================================
   預測快照 — 資料讀取層

   ── 資料怎麼走到這裡 ──────────────────────────────
     [RF 隨機森林 / LSTM]  預測結果
          │  pymongo upsert（連線字串只在本機／CI，絕不進前端）
          ▼
     [MongoDB Atlas]  hems.load_forecast、actual_load、pv_forecast、actual_pv  ← 唯一資料來源
          │  mongo_handoff/04_export_web.py（建置時執行）
          ▼
     public/data/forecast_day.json               夏月展示日（2010-09-06）  ← 本檔讀這些
     public/data/forecast_day_non_summer.json    非夏月展示日（2010-11-18）
     public/data/weather.json                    展示日期的台北 ERA5 天氣（scripts/fetch_weather.py）
          ▼
     [HEMS UI]  主頁面預測圖 / 各負載 / 用電規劃

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
   本專題的預測資料是固定的歷史資料集（UCI 2010 年），這個代價等於零。
   日後接上即時資料時，把檔名換成後端 API 的網址即可，回傳格式不變。
   ============================================================ */

const BASE = `${import.meta.env.BASE_URL}data/`

/** 兩個情境各一份展示日快照。非夏月那份是用 04_export_web.py --day 2010-11-18 匯出後另存的 */
const SHOWCASE_FILES = {
  summer: 'forecast_day.json',
  non_summer: 'forecast_day_non_summer.json',
}

/** 靜態檔理論上不會慢，但檔案不存在時不要讓 UI 一直轉圈 */
const TIMEOUT_MS = 5000

async function getJson(file) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(BASE + file, { signal: ctrl.signal, cache: 'no-cache' })
    if (!r.ok) throw new Error(`讀取 ${file} 失敗 ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取某個情境展示日的一日 96 格。
 *
 * 匯出端已經挑好 23:45 發布的那筆並攤成 0~95 格（見 04_export_web.py），
 * 前端不再需要知道 lead_step 與 target_time 的對應規則。
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
    pvSource: d.pv_source ?? null,
    targetDate: d.target_date ?? null,
    hasActual: Boolean(d.has_actual),
    source: d.source ?? null,
    generatedAt: d.generated_at ?? null,
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
