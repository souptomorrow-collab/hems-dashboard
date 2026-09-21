/* ============================================================
   資料存取層（API Client）

   ── 目前的接線狀況 ──────────────────────────────
   家庭負載（不可轉移）：**已接真實資料**。
     RF 隨機森林的一整年滾動預測存在 MongoDB Atlas 的 hems.load_forecast，
     網站透過後端 API（hems-api）讀取，API 連不上時改讀 scripts/export_snapshots.py
     匯出的靜態快照，覆蓋掉模擬的不可轉移負載（詳見 api/forecastData.js）。
     兩者都讀不到時自動退回模擬值，UI 不會壞掉（badge 會標示資料來源）。

   太陽能發電（LSTM）：**已接真實資料**。
     發電量預測組的 LSTM 結果存在 hems.pv_forecast（每天 23:45 發布一次，
     和 UI 使用的負載預測一樣，一天一次），讀取方式同上。
     讀不到時退回模擬的晴空曲線。

   天氣：**已接真實資料**。
     資料集那一天台北的 open-meteo ERA5 再分析資料（scripts/fetch_weather.py），
     和發電量預測模型的輸入同一個來源，天氣條和太陽能曲線才對得起來。
     讀不到時退回模擬天氣。

   夏月／非夏月：兩個情境各一份展示日快照，由 lib/scenario.js 切換。

   電池排程：**已接排程組的結果**（有的日子）。
     排程組的 MILP 排程存在 hems.schedule，讀取方式同上（快照為 public/data/schedule.json）。
     展示日有排程、且當天電價相符（週一至週五）時，
     電池照排程充放電（simulate.js 的 dispatchPlan）；沒有排程的日子（目前是非夏月、週末）
     才用模擬調度。可轉移設備的時段排程組還沒提供，仍由 UI 依電價安排。

   所有函式都回傳 Promise。
   ============================================================ */
import { liveSnapshot, simulateDay, simulateWithSchedule } from '../lib/simulate.js'
import { tomorrow } from '../lib/format.js'
import { nowTaipei } from '../lib/time.js'
import { simulateWeather, weatherFromEra5 } from '../lib/weather.js'
import { fetchDayAheadForecast, fetchWeatherData, fetchSchedules, cached, getJson } from './forecastData.js'
import { isSummer } from '../lib/tou.js'
import { getScenario, scenarioDate } from '../lib/scenario.js'
import { DEVICES } from '../lib/constants.js'

const delay = (ms) => new Promise((res) => setTimeout(res, ms))

/* ------------------------------------------------------------
   ★ 時間軸的處理 ★
   預測資料的時間戳是資料集本身的日期（UCI household_power_consumption，
   法國 Sceaux 住宅；夏月情境 2010-07-19、非夏月情境 2010-01-11），
   而 UI 顯示的是當下的今日／明日。
   這裡是**依「一日中的時段」(0~95) 對齊**，不做日期換算：
   曲線形狀完全是 RF／LSTM 的真實輸出，只是掛在畫面當天的日期標籤下。
   實際部署接上即時資料後，日期自然就會對上，這層對齊可以直接拿掉。
   ------------------------------------------------------------ */
let lastForecastMeta = {
  source: 'sim',
  refresh: null,
  datasetDate: null,
  error: null,
}

let lastPvMeta = { source: 'sim', datasetDate: null, error: null }

/**
 * 組出「站在第 atSlot 格」的一日 96 格不可轉移負載。
 *
 *   過去（0..atSlot）  用當天真實值
 *   未來（atSlot+1..） 用前一晚 23:45 發布的日前預測
 *
 * RF 雖然每 15 分鐘會重發一次未來 96 步（快照裡的 rolling），但排程組一天只排一次、
 * 用的是前一晚 23:45 那次預測，所以 UI 也只用那一次，整天不隨時間更新，
 * 畫面上的預測才和排程的輸入一致。
 *
 * atSlot 給 null 就是整日的日前預測（例如頁面三的隔日規劃，那時還沒有真實值）。
 */
function assembleFixed(d, atSlot, dayAhead) {
  const future = dayAhead ?? d.slots
  if (atSlot == null) return future
  const s = Math.max(0, Math.min(95, atSlot))
  return future.map((v, i) => (i <= s ? (d.actual?.[i] ?? v) : v))
}

/** 可轉移設備的額定功率（kW），以英文代號查 */
const RATED_KW = Object.fromEntries(
  DEVICES.filter((d) => d.category === 'shiftable').map((d) => [d.id, d.ratedW / 1000]))

/**
 * 排程的 load_kw 含使用者存下的可轉移設備（排程是照那些時段排的）。
 * 這裡要的是不可轉移負載：把設備功率扣掉，設備另外由甘特圖加回來，才不會算兩次。
 */
function nonShiftable(plan) {
  const dev = Object.entries(plan.devices ?? {})
  if (!dev.length) return plan.load_kw
  return plan.load_kw.map((v, i) =>
    +Math.max(0, v - dev.reduce((a, [id, on]) => a + (on?.[i] ? (RATED_KW[id] ?? 0) : 0), 0)).toFixed(4))
}

/**
 * 展示日的日前負載預測（前一晚 23:45 發布、一天一次）。
 * 那天有排程組的排程時，用排程裡的 load_kw（扣掉可轉移設備）：電池功率是針對這條負載排的，
 * 資料庫的預測之後若重算過（2026-09-17 改為一整年 walk-forward），兩者會不同，
 * 混用會讓購電與電池對不上。沒有排程時用 history 的 day_ahead，
 * 都沒有才由呼叫端退回快照的 slots（當天 00:00 發布那筆）。
 */
async function dayAheadLoad(dateStr, plan) {
  const ok = (a) => Array.isArray(a) && a.length === 96 && a.every(Number.isFinite)
  if (ok(plan?.load_kw)) return nonShiftable(plan)
  const da = (await fetchHistory())?.days?.find((x) => x.date === dateStr)?.day_ahead
  return ok(da) ? da : null
}

/** 某個情境的展示日快照；整個 app 每個情境只讀一次 */
function showcase(season) {
  return cached(`day-ahead-forecast:${season}`, () => fetchDayAheadForecast(season))
}

/* ------------------------------------------------------------
   天氣：weather.json 以資料集日期為鍵，轉換結果記起來重複用
   ------------------------------------------------------------ */
const era5Memo = new Map()

async function weatherData() {
  try {
    return await cached('weather', fetchWeatherData)
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[HEMS] 讀不到天氣資料，改用模擬天氣：', e.message)
    return null
  }
}

/* ------------------------------------------------------------
   排程組的排程：schedule.json 以資料集日期為鍵，讀不到就當作沒有排程
   ------------------------------------------------------------ */
async function schedules() {
  try {
    return await cached('schedule', fetchSchedules)
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[HEMS] 讀不到排程快照，電池改用模擬調度：', e.message)
    return null
  }
}

async function planFor(dateStr) {
  return dateStr ? ((await schedules())?.byDate?.[dateStr] ?? null) : null
}

function era5For(wx, dateStr) {
  const rows = dateStr ? wx?.days?.[dateStr] : null
  if (!rows) return null
  if (!era5Memo.has(dateStr)) {
    // 天氣檔某一天的欄位不齊（例如少了晴空指數）時，原本轉換會丟例外、整條資料流斷掉，
    // 圖表一直停在載入中。改成那一天退回模擬天氣，其他資料照常顯示
    let w = null
    try {
      w = weatherFromEra5(rows, dateStr)
    } catch (e) {
      if (import.meta.env.DEV) console.warn(`[HEMS] ${dateStr} 的天氣資料格式不對，改用模擬天氣：`, e.message)
    }
    era5Memo.set(dateStr, w)
  }
  return era5Memo.get(dateStr)
}

/**
 * 目前情境的輸入：不可轉移負載（96 格）、太陽能（96 格）、天氣。
 * 讀不到快照時三者都回 null，各函式自動改用模擬值。
 */
async function scenarioInputs(atSlot = null) {
  const season = getScenario().season
  let d
  try {
    d = await showcase(season)
  } catch (e) {
    lastForecastMeta = { source: 'sim', refresh: null, datasetDate: null, error: e.message }
    lastPvMeta = { source: 'sim', datasetDate: null, error: e.message }
    if (import.meta.env.DEV) console.warn('[HEMS] 取雲端預測快照失敗，改用模擬值：', e.message)
    return { season, fixed: null, pv: null, weather: null, plan: null }
  }
  const plan = await planFor(d.targetDate)
  // 快照的 slots 是當天 00:00 發布那筆（第 0 格還換成真實值），和排程組的輸入最多差 0.25 kW，
  // 所以預測一律改用前一晚 23:45 的日前預測
  const dayAhead = await dayAheadLoad(d.targetDate, plan)
  lastForecastMeta = {
    source: 'rf',
    refresh: dayAhead ? '前一晚 23:45 發布（一天一次）' : '當天 00:00 發布',
    datasetDate: d.targetDate,
    error: null,
  }
  lastPvMeta = d.pv
    ? { source: 'lstm', datasetDate: d.targetDate, error: null }
    : { source: 'sim', datasetDate: null, error: '快照無發電量預測' }
  return {
    season,
    fixed: assembleFixed(d, atSlot, dayAhead),
    pv: d.pv,
    weather: era5For(await weatherData(), d.targetDate),
    plan,
  }
}

/**
 * 主頁面「負載預測與實際」與「太陽能預測與實際」兩張圖要的原始資料。
 *
 * 其他圖拿到的是已經組好的單一條負載曲線（過去接真實值），看不出預測本身；
 * 這兩張要把「日前預測」和「實際」並排畫出來，所以需要原始陣列。
 * 讀不到時回 null，那兩張圖就不顯示。
 */
export async function fetchShowcase() {
  const season = getScenario().season
  try {
    const d = await showcase(season)
    return {
      season,
      targetDate: d.targetDate,
      dayAhead: await dayAheadLoad(d.targetDate, await planFor(d.targetDate)),
      actual: d.actual,
      pv: d.pv,
      pvActual: d.pvActual,
      weather: era5For(await weatherData(), d.targetDate),
    }
  } catch {
    return null
  }
}

/**
 * 歷史紀錄：逐日的真實值、日前預測、一步預測（history.json）。
 * 和其他資料一樣先讀後端 API，讀不到再用 MongoDB 匯出的靜態快照（見 forecastData.js 的 getJson）。
 * @returns {Promise<{days:Array, source:string, generatedAt:string, via:string}|null>}
 */
export async function fetchHistory() {
  return cached('history', async () => {
    const d = await getJson('history.json')
    // 只收日期格式正確的日子：日期欄位壞掉（例如變成數字）時，後面拆日期會丟例外，頁面會一直停在載入中
    const days = (Array.isArray(d.days) ? d.days : [])
      .filter((x) => typeof x?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date))
    return { days, source: d.source ?? null, generatedAt: d.generated_at ?? null, via: d.via }
  }).catch(() => null)
}

/* ------------------------------------------------------------
   用電紀錄（歷史紀錄頁，電費帳單式）

   系統還沒接實際電表，沒有真實的逐日量測紀錄，所以每個過去的日期都
   「用同一套模擬引擎重跑一次」：依那天的電價（夏月／非夏月、平日／假日）
   算出太陽能、電池、電網與電費。

   不可轉移負載、太陽能與天氣改用資料集裡「同季節、同一個星期幾」那天的實際資料：
   夏月（2010-07-19～22）與非夏月（2010-01-11～24）兩個展示週有發電量預測、天氣與排程，
   剛好週一到週日各一天，平日／週末與季節的差異都是真的，而不是模擬值。
   歷史資料有一整年（2009-11-26～2010-11-25），但其他日子沒有發電量預測與天氣，
   所以優先挑這兩週的日子。
   ------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, '0')
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const usageCache = new Map() // 'YYYY-MM-DD' → 當日紀錄；切換區間時不必重算
const simCache = new Map() // 'YYYY-MM-DD' → 當日完整模擬結果（單日紀錄頁用）

/**
 * 資料集的日子依「夏月／非夏月」與星期幾分組：{ summer: {0..6}, other: {0..6} }。
 * 只照星期幾挑的話，後面的 11 月會蓋掉 9 月，夏天的日期就會用到非夏月的負載與太陽能。
 */
async function weekdayProfiles() {
  const hist = await fetchHistory()
  const profiles = { summer: {}, other: {} }
  for (const d of hist?.days ?? []) {
    const day = parseYmd(d.date)
    const group = profiles[isSummer(day) ? 'summer' : 'other']
    const cur = group[day.getDay()]
    // 有發電量預測的日子（展示週）優先；都沒有時用該季節最早的同星期幾
    if (!cur || (!cur.pv_day_ahead && d.pv_day_ahead)) group[day.getDay()] = d
  }
  return profiles
}

/** 挑同季節、同星期幾的那天；該季節沒有就退回另一季 */
function profileFor(profiles, t) {
  const [want, alt] = isSummer(t) ? ['summer', 'other'] : ['other', 'summer']
  return profiles[want][t.getDay()] ?? profiles[alt][t.getDay()] ?? null
}

/**
 * 某一天的完整模擬結果（每 15 分鐘的能量流、排程、各設備功率、天氣）。
 * 與 fetchDailyUsage 用同一套負載曲線與模擬引擎，所以兩邊的數字一致。
 */
function simulateOn(t, profiles, wx, plans) {
  const key = ymd(t)
  if (!simCache.has(key)) {
    const prof = profileFor(profiles, t)
    // 負載、發電量、天氣、排程都取資料集同一天，條件才會一致
    // （別讓晴天的太陽能配上陰天的天氣條）
    const era5 = era5For(wx, prof?.date)
    simCache.set(key, {
      sim: simulateDay(t, era5 ?? simulateWeather(t), prof?.actual ?? null,
                       prof?.pv_day_ahead ?? null, plans?.byDate?.[prof?.date] ?? null),
      profileFrom: prof?.date ?? null,
      weatherFrom: era5 ? 'era5' : 'sim',
    })
  }
  return simCache.get(key)
}

export async function fetchDaySim(dateStr) {
  const [profiles, wx, plans] = await Promise.all([weekdayProfiles(), weatherData(), schedules()])
  return simulateOn(parseYmd(dateStr), profiles, wx, plans)
}

/**
 * 區間內每天一筆的用電紀錄（含頭尾兩天）。
 * @returns {Promise<{rows:Array, profileDates:object}>}
 */
export async function fetchDailyUsage(fromStr, toStr) {
  const [profiles, wx, plans] = await Promise.all([weekdayProfiles(), weatherData(), schedules()])

  const rows = []
  for (let t = parseYmd(fromStr), end = parseYmd(toStr); t <= end; t = addDays(t, 1)) {
    const key = ymd(t)
    if (!usageCache.has(key)) {
      const { sim, profileFrom } = simulateOn(t, profiles, wx, plans)
      const sum = sim.summary
      usageCache.set(key, {
        date: key,
        weekday: t.getDay(),
        loadKwh: sum.loadKwh,
        pvKwh: sum.pvKwh,
        gridKwh: sum.gridImportKwh,
        dischargeKwh: sum.dischargeKwh,
        cost: sum.optimizedCost,
        baseline: sum.baselineCost, // 不裝 HEMS（無太陽能、無電池，全部向台電買）的電費
        savings: sum.savings,
        selfUse: sum.selfUseRate,
        profileFrom,
      })
    }
    rows.push(usageCache.get(key))
  }
  const dates = (g) => Object.fromEntries(Object.entries(g).map(([w, d]) => [w, d.date]))
  const profileDates = { summer: dates(profiles.summer), other: dates(profiles.other) }
  return { rows, profileDates }
}

/**
 * 目前負載資料的來源（UI 標示用）。
 * @returns {{source:'rf'|'sim', refresh:string|null, datasetDate:string|null, error:string|null}}
 */
export function loadForecastMeta() {
  return lastForecastMeta
}

/**
 * 目前發電量資料的來源（UI 標示用）。
 * @returns {{source:'lstm'|'sim', datasetDate:string|null, error:string|null}}
 */
export function pvForecastMeta() {
  return lastPvMeta
}

/* ------------------------------------------------------------
   今天／明天這幾頁：資料取目前情境（夏月／非夏月）的展示日，
   電價用 scenarioDate() 換到該季節裡星期幾相同的日期去查。
   回傳值多帶一個 season，頁面可以判斷拿到的是不是目前情境的資料
   （切換情境的瞬間，舊情境的請求可能晚一步才回來）。
   ------------------------------------------------------------ */

/** 主頁面即時快照（太陽能/電池/負載/電網/SOC/省電費…） */
export async function fetchLive(now = nowTaipei(), atSlot = null) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs(atSlot)
  const at = scenarioDate(now, season)
  await delay(60)
  return { ...liveSnapshot(at, fixed, pv, weather ?? simulateWeather(at), plan), season }
}

/** 今日整日（主頁面的 24h 趨勢圖、最佳化結果） */
export async function fetchToday(now = nowTaipei(), atSlot = null) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs(atSlot)
  const at = scenarioDate(now, season)
  await delay(80)
  return { ...simulateDay(at, weather ?? simulateWeather(at), fixed, pv, plan), season }
}

/** 隔日預測 + 最佳化排程（頁面三規劃） */
export async function fetchPlanning(baseDate = nowTaipei()) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs()
  const date = scenarioDate(tomorrow(baseDate), season)
  await delay(120)
  return { ...simulateDay(date, weather ?? simulateWeather(date), fixed, pv, plan), season }
}

/**
 * 依使用者手動調整後的排程重新計算電池調度與成本（不重跑 GA）。
 * @param {object} schedule  { deviceId: boolean[96] }
 */
export async function recomputeSchedule(schedule, baseDate = nowTaipei()) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs()
  const date = scenarioDate(tomorrow(baseDate), season)
  await delay(60)
  return {
    ...simulateWithSchedule(date, schedule, weather ?? simulateWeather(date), fixed, pv, plan),
    season,
  }
}
