/* ============================================================
   Supabase（PostgREST）讀取層 — 不可轉移負載預測

   資料來源即為專題的預測子系統：
     [RF 預測程式] 每 15 分 predict_matrix()
          │ 寫入（service_role key，只在本機端）
          ▼
     [Supabase / PostgreSQL]  load_forecast、actual_load
          │ 查詢（anon key，只讀，RLS 已鎖）  ← 本檔在這一層
          ▼
     [HEMS UI] 主頁面預測圖 / 用電規劃 / 預測驗證頁

   這裡用的是 anon（publishable）key：資料表已開 Row Level Security，
   只允許 SELECT，所以放進前端 bundle 是安全的、也是它設計上的用途。
   可寫的 service_role key 絕不會出現在前端。

   要換專案時設環境變數即可（.env.local）：
     VITE_SUPABASE_URL=https://xxxx.supabase.co
     VITE_SUPABASE_KEY=<anon key>
   ============================================================ */

const URL =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://wpkrtkqoqqdposjvpnxc.supabase.co'
const KEY =
  import.meta.env.VITE_SUPABASE_KEY ??
  'sb_publishable_dSC8fQx9AxWoDhlo8N8XtQ_zUo87_H-'

const REST = `${URL}/rest/v1`
const HEAD = { apikey: KEY, Authorization: `Bearer ${KEY}` }

/** 逾時保護：雲端沒回應時不要讓 UI 一直轉圈（Supabase 免費版有冷啟動） */
const TIMEOUT_MS = 8000

async function get(path, { count = false } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${REST}/${path}`, {
      headers: count ? { ...HEAD, Prefer: 'count=exact' } : HEAD,
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`Supabase ${r.status} ${r.statusText}`)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------
   時間處理

   資料庫存的是 timestamptz，回傳長這樣：2010-11-18T00:15:00+00:00。
   但來源 CSV（UCI household_power_consumption）本來就是「無時區的牆上時間」，
   上傳時被當成 UTC 存入。所以這裡一律**照字面**解析，不做時區換算，
   否則畫出來的曲線會整條平移 8 小時。
   ------------------------------------------------------------ */

/** "2010-11-18T00:15:00+00:00" → { y,m,d,hh,mm } 純字面 */
export function parseWall(ts) {
  const m = String(ts).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  return {
    y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5],
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: `${m[4]}:${m[5]}`,
    iso: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:00`,
  }
}

/** 牆上時間 → 一天中的第幾個 15 分鐘時段（0~95），用來對齊 UI 的日曆格 */
export function wallToSlot(ts) {
  const w = parseWall(ts)
  return w ? Math.floor((w.hh * 60 + w.mm) / 15) : 0
}

/* ------------------------------------------------------------
   查詢
   ------------------------------------------------------------ */

/** 資料庫裡最新的 refresh_time（= 預測服務最後一次刷新的時刻） */
export async function fetchLatestRefresh() {
  const rows = await get(
    'load_forecast?select=refresh_time&order=refresh_time.desc&limit=1'
  )
  return rows[0]?.refresh_time ?? null
}

/** 某個 refresh 的完整 96 步預測（lead_step 1~96 遞增） */
export async function fetchForecast(refreshTime) {
  const q = encodeURIComponent(refreshTime)
  return get(
    `load_forecast?refresh_time=eq.${q}` +
      '&select=refresh_time,target_time,lead_step,predicted_load_kw,is_holiday,is_weekend' +
      '&order=lead_step.asc'
  )
}

/** 最新一筆 refresh 的 96 步 */
export async function fetchLatestForecast() {
  const refresh = await fetchLatestRefresh()
  if (!refresh) return { refresh: null, rows: [] }
  return { refresh, rows: await fetchForecast(refresh) }
}

/**
 * 「隔日預測」用的 refresh：挑 23:45 發布的那一筆。
 *
 * 為什麼不直接用最新的？最新一筆是 23:30，它的 96 步是
 * 23:45 → 隔天 23:30，攤回一日 96 格時會跨午夜、在接縫處把
 * 「領先 1 步」和「領先 96 步」的預測接在一起，曲線會有假的斷階。
 * 改用 23:45 發布的，lead 1~96 剛好等於隔日 00:00~23:45，
 * 整條曲線都是同一次刷新、領先步數單調遞增，語意才乾淨
 * （這也正是交接給 GA 的 load_forecast_*_1day.csv 的取法）。
 */
export async function fetchDayAheadForecast() {
  // 往回找 100 個 refresh（約 25 小時）必定涵蓋一個 23:45
  const recent = await get(
    'load_forecast?select=refresh_time&lead_step=eq.1&order=refresh_time.desc&limit=100'
  )
  const hit = recent
    .map((r) => r.refresh_time)
    .find((t) => {
      const w = parseWall(t)
      return w && w.hh === 23 && w.mm === 45
    })
  const refresh = hit ?? recent[0]?.refresh_time ?? null
  if (!refresh) return { refresh: null, rows: [], targetDate: null, clean: false }

  const rows = await fetchForecast(refresh)
  return {
    refresh,
    rows,
    // 這批預測涵蓋的是哪一天（給 UI 標示「資料日期」用）
    targetDate: parseWall(rows[0]?.target_time)?.date ?? null,
    clean: Boolean(hit), // true = 完整對齊一日 00:00~23:45
  }
}

/**
 * 可選的 refresh_time 清單（預測驗證頁的下拉選單）。
 * 一天 96 個 refresh、7 天共 672 個，全給太多；
 * 這裡取每個整點的 refresh（每天 24 個）當代表。
 */
export async function fetchRefreshOptions() {
  const rows = await get(
    'load_forecast?select=refresh_time&lead_step=eq.1&order=refresh_time.asc'
  )
  return rows
    .map((r) => r.refresh_time)
    .filter((t) => parseWall(t)?.mm === 0)
}

/** 指定時間區間的真實值（事後比對用） */
export async function fetchActual(fromTs, toTs) {
  const a = encodeURIComponent(fromTs)
  const b = encodeURIComponent(toTs)
  return get(
    `actual_load?time=gte.${a}&time=lte.${b}` +
      '&select=time,actual_load_kw&order=time.asc'
  )
}

export const SUPABASE_INFO = { url: URL, table: 'load_forecast' }
