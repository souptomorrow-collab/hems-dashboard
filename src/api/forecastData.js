/* ============================================================
   不可轉移負載預測 — 資料讀取層

   ── 資料怎麼走到這裡 ──────────────────────────────
     [RF 隨機森林]  每 15 分 predict_matrix()
          │  pymongo upsert（連線字串只在本機／CI，絕不進前端）
          ▼
     [MongoDB Atlas]  hems.load_forecast、hems.actual_load   ← 唯一資料來源
          │  mongo_handoff/04_export_web.py（建置時執行一次）
          ▼
     public/data/forecast_day.json                            ← 本檔讀這個
          ▼
     [HEMS UI]  主頁面預測圖 / 用電規劃

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
   本專題的預測資料是固定的歷史資料集（UCI 2010-11），這個代價等於零。
   日後接上即時資料時，把 DATA_URL 換成後端 API 的網址即可，回傳格式不變。
   ============================================================ */

const DATA_URL = `${import.meta.env.BASE_URL}data/forecast_day.json`

/** 靜態檔理論上不會慢，但檔案不存在時不要讓 UI 一直轉圈 */
const TIMEOUT_MS = 5000

/**
 * 取「隔日預測」的一日 96 格。
 *
 * 匯出端已經挑好 23:45 發布的那筆並攤成 0~95 格（見 04_export_web.py），
 * 前端不再需要知道 lead_step 與 target_time 的對應規則。
 *
 * @returns {{refresh:string|null, slots:number[]|null, targetDate:string|null,
 *            clean:boolean, source:string|null}}
 */
export async function fetchDayAheadForecast() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(DATA_URL, { signal: ctrl.signal, cache: 'no-cache' })
    if (!r.ok) throw new Error(`讀取預測快照失敗 ${r.status}`)
    const d = await r.json()

    const slots = Array.isArray(d.slots) ? d.slots : null
    if (!slots || slots.length !== 96) {
      throw new Error(`預測快照格式不對（slots=${slots?.length ?? 'none'}）`)
    }
    return {
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
  } finally {
    clearTimeout(timer)
  }
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

export function cached(key, loader) {
  if (!cache.has(key)) {
    cache.set(
      key,
      loader().catch((e) => {
        cache.delete(key) // 失敗不留壞值，下次可重試
        throw e
      })
    )
  }
  return cache.get(key)
}
