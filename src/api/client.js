/* ============================================================
   資料存取層（API Client）

   ── 目前的接線狀況 ──────────────────────────────
   家庭負載（不可轉移）：**已接真實資料**。
     RF 隨機森林的一整年滾動預測存在 MongoDB Atlas 的 hems.load_forecast，
     網站透過後端 API（hems-api）讀取，API 連不上時改讀 scripts/export_snapshots.py
     匯出的靜態快照，覆蓋掉模擬的不可轉移負載（詳見 api/forecastData.js）。
     兩者都讀不到時自動退回模擬值，UI 不會壞掉（badge 會標示資料來源）。

   太陽能發電（LSTM）：**已接真實資料**。
     發電量預測組的 LSTM 結果存在 hems.pv_forecast（每天 23:45 發布一次、一次 48 小時，
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
import { liveSnapshot, simulateDay, simulateWithSchedule, pack } from '../lib/simulate.js'
import { nowTaipei } from '../lib/time.js'
import { simulateWeather, weatherFromEra5 } from '../lib/weather.js'
import { fetchDayAheadForecast, fetchWeatherData, fetchSchedules, fetchOperation, fetchPlans, cached, refreshCached, getJson } from './forecastData.js'
import { isSummer, getPriceSlots, getTierSlots } from '../lib/tou.js'
import { getScenario, nextDayOf, todayOf, scenarioNow, scenarioDate, SEASONS } from '../lib/scenario.js'
import { getDemo } from '../lib/demoClock.js'

/* 可轉移設備：展示模式照資料庫的排程（使用者確認的時段）；平常模式是模擬的，
   由模擬在允許時段內挑最便宜的時段當建議時段，並假設使用者照建議確認（三台每天都跑） */
const routineFor = () => null
import { DEVICES, UNASSIGNED, SLOTS_PER_DAY, SLOT_HOURS, slotToTime } from '../lib/constants.js'

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

/** 資料集某一天的原始資料：展示日讀展示日快照（API 掛掉時也有），其他日子從歷史紀錄組 */
function dayData(season, day) {
  return day === SEASONS.find((s) => s.key === season)?.dataset ? showcase(season) : historyDay(day)
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

/** 資料集某一天（例如隔日）的輸入，從歷史紀錄組：日前預測、實際、發電量預測 */
async function historyDay(dateStr) {
  const x = (await fetchHistory())?.days?.find((v) => v.date === dateStr)
  if (!x?.day_ahead) throw new Error(`歷史紀錄沒有 ${dateStr}`)
  return {
    targetDate: x.date, slots: x.day_ahead, actual: x.actual ?? null,
    pv: x.pv_day_ahead ?? null, pvActual: x.pv_actual ?? null,
  }
}

/**
 * 目前情境的輸入：不可轉移負載（96 格）、太陽能（96 格）、天氣。
 * day 不給是今天（todayOf：平常＝展示日，展示模式＝播放中的那一天），給資料集日期就是那一天（用電規劃頁的隔日）。
 * 讀不到快照時三者都回 null，各函式自動改用模擬值。
 */
async function scenarioInputs(atSlot = null, day = null) {
  const season = getScenario().season
  // 平常（沒開展示模式）一律模擬：負載、太陽能、天氣都不給，各函式自己用模擬值；
  // 沒有排程組的排程，電池也是模擬調度、可轉移設備照電價自動排
  if (!getDemo().enabled) {
    lastForecastMeta = { source: 'sim', refresh: null, datasetDate: null, error: null }
    lastPvMeta = { source: 'sim', datasetDate: null, error: null }
    return { season, fixed: null, pv: null, weather: null, plan: null }
  }
  let d
  try {
    d = await dayData(season, day ?? todayOf(season))
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
  if (!getDemo().enabled) return null // 平常是模擬的，沒有預測與實際的原始資料可以對照
  try {
    const d = await dayData(season, todayOf(season))
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

/* ------------------------------------------------------------
   展示模式的歷史紀錄：資料庫的實時運轉結果（兩個展示月）
   /operation 每天 96 筆（每 15 分鐘，逐秒控制 900 次的平均）：負載（含設備）、太陽能、
   電池（正＝充電）、購電、棄光、SOC，以及每格在跑的可轉移設備。這裡拆成和模擬引擎相同的
   六條能量流，交給同一支 pack() 組出單日結構，歷史頁的圖表與數字就不必分兩套寫。
   拆法：太陽能扣掉棄光先供負載；充電時剩下的太陽能先充、不夠由電網充；放電時電池先供負載，
   其餘由電網補——這樣算出的購電就是紀錄裡的購電。
   ------------------------------------------------------------ */
const actualCache = new Map() // 'YYYY-MM-DD' → { stamp, res }；使用者改設定、本機重算後 prefs_stamp 會變

async function operationDays() {
  return (await cached('operation', fetchOperation))?.byDate ?? {}
}

function actualOn(dateStr, day, wx) {
  const hit = actualCache.get(dateStr)
  if (hit && hit.stamp === day.prefs_stamp) return hit.res
  const t = parseYmd(dateStr)
  const price = getPriceSlots(t)
  const tier = getTierSlots(t)
  const flows = { pvToLoad: [], pvToBatt: [], pvToGrid: [], battToLoad: [], gridToLoad: [], gridToBatt: [], socPct: [] }
  const tot = { tPv: 0, tLoad: 0, tGridImport: 0, tCharge: 0, tDischarge: 0, tReverse: 0, optCost: 0, baseCost: 0 }
  const r3 = (v) => +v.toFixed(3)
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const L = day.load_kw[s]
    const PV = day.pv_kw[s]
    const B = day.batt_kw[s]
    const C = day.curtail_kw[s]
    const used = Math.max(0, PV - C)
    let p2l
    let p2b = 0
    let b2l = 0
    let g2b = 0
    if (B >= 0) {
      p2l = Math.min(used, L)
      p2b = Math.min(used - p2l, B)
      g2b = B - p2b
    } else {
      b2l = -B
      p2l = Math.min(used, Math.max(0, L - b2l))
    }
    const g2l = Math.max(0, L - p2l - b2l)
    flows.pvToLoad.push(r3(p2l)); flows.pvToBatt.push(r3(p2b)); flows.pvToGrid.push(r3(C))
    flows.battToLoad.push(r3(b2l)); flows.gridToLoad.push(r3(g2l)); flows.gridToBatt.push(r3(g2b))
    flows.socPct.push(day.soc_pct[s])
    const buy = (g2l + g2b) * SLOT_HOURS
    tot.tPv += PV * SLOT_HOURS; tot.tLoad += L * SLOT_HOURS; tot.tGridImport += buy
    tot.tCharge += Math.max(0, B) * SLOT_HOURS; tot.tDischarge += b2l * SLOT_HOURS; tot.tReverse += C * SLOT_HOURS
    tot.optCost += buy * price[s]; tot.baseCost += L * SLOT_HOURS * price[s]
  }
  const sim = pack(t, day.pv_kw, day.load_kw, price, tier, flows, tot)
  // 設備：可轉移設備照每格在跑的紀錄乘額定功率；不可轉移負載沒有分項，整筆算「未分項」
  const on = (id) => (day.devices?.[id] ?? []).slice(0, SLOTS_PER_DAY).map(Boolean)
  const shift = DEVICES.filter((d) => d.category === 'shiftable')
  const devicePower = {}
  for (const d of shift) devicePower[d.id] = on(d.id).map((x) => (x ? d.ratedW / 1000 : 0))
  devicePower[UNASSIGNED.id] = day.load_kw.map((v, s) =>
    r3(Math.max(0, v - shift.reduce((a, d) => a + devicePower[d.id][s], 0))))
  const era5 = era5For(wx, dateStr)
  Object.assign(sim, {
    devicePower,
    schedule: Object.fromEntries(DEVICES.map((d) =>
      [d.id, d.category === 'shiftable' ? on(d.id) : new Array(SLOTS_PER_DAY).fill(false)])),
    weather: era5 ?? simulateWeather(t),
    planSource: 'actual',
    planDate: dateStr,
  })
  const res = { sim, profileFrom: dateStr, weatherFrom: era5 ? 'era5' : 'sim', actual: true }
  actualCache.set(dateStr, { stamp: day.prefs_stamp, res })
  return res
}

/** 展示月某一天的實時運轉紀錄（格式同 fetchDaySim）。資料庫沒有那天就丟錯，頁面會顯示原因 */
export async function fetchDayActual(dateStr) {
  const [days, wx] = await Promise.all([operationDays(), weatherData()])
  const day = days[dateStr]
  if (!day) throw new Error(`資料庫沒有 ${dateStr} 的實時運轉紀錄`)
  return actualOn(dateStr, day, wx)
}

/** 展示月區間內每天一筆的實時運轉紀錄（格式同 fetchDailyUsage；沒有紀錄的日子略過） */
export async function fetchDailyActual(fromStr, toStr) {
  const [days, wx] = await Promise.all([operationDays(), weatherData()])
  const rows = []
  for (let t = parseYmd(fromStr), end = parseYmd(toStr); t <= end; t = addDays(t, 1)) {
    const key = ymd(t)
    if (!days[key]) continue
    const sum = actualOn(key, days[key], wx).sim.summary
    rows.push({
      date: key, weekday: t.getDay(), loadKwh: sum.loadKwh, pvKwh: sum.pvKwh, gridKwh: sum.gridImportKwh,
      dischargeKwh: sum.dischargeKwh, cost: sum.optimizedCost, baseline: sum.baselineCost,
      savings: sum.savings, selfUse: sum.selfUseRate, profileFrom: key,
    })
  }
  return { rows, profileDates: null }
}

/* ------------------------------------------------------------
   展示模式的歷史紀錄：日前計畫與實際運轉對照
   計畫＝前一晚 23:45 的日前排程（/schedules，tag=main）：負載與太陽能是那時的預測、電池與購電是 MILP 的計畫；
   實際＝實時運轉紀錄（/operation）。兩者的負載都含可轉移設備（計畫照預估的開機時間、實際照真的開機時間）。
   回傳兩邊各 96 格，以及總量（度）與電費；尖峰時段另外加總，說明差距集中在哪裡。
   ------------------------------------------------------------ */
export async function fetchPlanVsActual(dateStr) {
  const [plan, days] = await Promise.all([planFor(dateStr), operationDays()])
  const op = days[dateStr]
  if (!plan || !op) throw new Error(`${dateStr} 沒有${plan ? '實時運轉紀錄' : '日前排程'}`)
  const t = parseYmd(dateStr)
  const price = getPriceSlots(t)
  const tier = getTierSlots(t)
  const kwh = (a, only) => a.reduce((x, v, i) => x + (only && tier[i] !== only ? 0 : v * SLOT_HOURS), 0)
  const cost = (g) => g.reduce((x, v, i) => x + v * SLOT_HOURS * price[i], 0)
  const side = (load, pv, grid, batt, soc) => ({
    load, pv, grid, batt, soc,
    charge: batt.map((v) => Math.max(0, v)), discharge: batt.map((v) => Math.max(0, -v)),
    total: {
      load: kwh(load), loadPeak: kwh(load, 'peak'), pv: kwh(pv), grid: kwh(grid), gridPeak: kwh(grid, 'peak'),
      discharge: kwh(batt.map((v) => Math.max(0, -v))), cost: cost(grid),
    },
  })
  return {
    date: dateStr, tier,
    plan: side(plan.load_kw, plan.pv_kw, plan.grid_buy_kw, plan.batt_kw, plan.soc_pct),
    actual: side(op.load_kw, op.pv_kw, op.grid_kw, op.batt_kw, op.soc_pct),
  }
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
   今天／明天這幾頁：資料取目前情境（夏月／非夏月）的今天（todayOf），
   電價也照那一天查（scenarioNow：日期換成資料集的今天、時分照畫面上的時鐘），和排程用的一致。
   回傳值多帶一個 season，頁面可以判斷拿到的是不是目前情境的資料
   （切換情境的瞬間，舊情境的請求可能晚一步才回來）。
   ------------------------------------------------------------ */

/** 主頁面即時快照（太陽能/電池/負載/電網/SOC/省電費…） */
export async function fetchLive(now = nowTaipei(), atSlot = null) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs(atSlot)
  const at = scenarioNow(now, season)
  await delay(60)
  return { ...liveSnapshot(at, fixed, pv, weather ?? simulateWeather(at), plan, routineFor(at)), season }
}

/** 今日整日（主頁面的 24h 趨勢圖、最佳化結果） */
export async function fetchToday(now = nowTaipei(), atSlot = null) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs(atSlot)
  const at = scenarioNow(now, season)
  await delay(80)
  return { ...simulateDay(at, weather ?? simulateWeather(at), fixed, pv, plan, routineFor(at)), season }
}

/* ------------------------------------------------------------
   主頁面「未來 24 小時預測與排程」：從現在這一格起往後 96 格，過了午夜就接到明天
     展示模式  實時運轉層在這一格重排出來的計畫（/plans）：負載是這一格發布的 RF 滾動預測（含可轉移設備），
               太陽能是前一晚 23:45 發布的 48 小時 LSTM 預測（過了午夜仍是同一份），電池與電量是 MILP 的計畫——每 15 分鐘換一份
     平常模式  今天與明天各模擬一天再接起來
   回傳和 simulateDay 相同的欄位（pv、load、gridKw、chargeKw、dischargeKw、socPct、tier），另加
   labels（每格的時刻，明天的前面加「明天 」）與 midnight（明天 00:00 是第幾格；從 00:00 起算時是 null）。
   展示模式讀不到那一格的計畫就回 source 'none'，頁面改畫今日全天。
   ------------------------------------------------------------ */
const plansAt = new Map() // 'YYYY-MM-DD' → 上次重讀的時間（毫秒）

/** 某一天的 96 份計畫。使用者改了設定、本機重算後，那天實時運轉紀錄的 prefs_stamp 會先變，
    計畫的還是舊的就重讀一次（最多每 10 秒一次，播放中不會一直重抓） */
async function plansFor(date) {
  const key = `plans:${date}`
  let p = await cached(key, () => fetchPlans(date))
  const op = (await operationDays().catch(() => ({})))[date]
  const last = plansAt.get(date) ?? 0
  if (op?.prefs_stamp && p.prefsStamp !== op.prefs_stamp && Date.now() - last > 10000) {
    plansAt.set(date, Date.now())
    p = await refreshCached(key, () => fetchPlans(date)).catch(() => p)
  }
  return p
}

export async function fetchRolling(atSlot, now = nowTaipei()) {
  const s = Math.max(0, Math.min(SLOTS_PER_DAY - 1, atSlot ?? 0))
  const season = getScenario().season
  const labels = Array.from({ length: SLOTS_PER_DAY }, (_, i) =>
    `${s + i >= SLOTS_PER_DAY ? '明天 ' : ''}${slotToTime((s + i) % SLOTS_PER_DAY)}`)
  const midnight = s === 0 ? null : SLOTS_PER_DAY - s
  const span = (a, b) => a.slice(s).concat(b.slice(0, s)) // 今天從現在起、接明天到同一時刻為止
  if (getDemo().enabled) {
    const day = todayOf(season)
    let got = null
    try {
      got = day ? await plansFor(day) : null
    } catch (e) {
      if (import.meta.env.DEV) console.warn('[HEMS] 讀不到實時運轉層的計畫：', e.message)
    }
    const p = got?.bySlot?.[s]
    if (!p) return { season, source: 'none', startSlot: s }
    const t0 = parseYmd(day)
    return {
      season, source: 'rolling', planDate: day, startSlot: s, labels, midnight, via: got.via,
      tier: span(getTierSlots(t0), getTierSlots(addDays(t0, 1))),
      pv: p.pv_kw, load: p.load_kw, gridKw: p.grid_buy_kw, socPct: p.soc_pct,
      chargeKw: p.batt_kw.map((v) => Math.max(0, v)),
      dischargeKw: p.batt_kw.map((v) => Math.max(0, -v)),
      devices: p.devices ?? {},
    }
  }
  const [a, b] = await Promise.all([fetchToday(now), fetchPlanning()])
  if (!b) return { season, source: 'none', startSlot: s }
  const out = { season, source: 'sim', startSlot: s, labels, midnight }
  for (const k of ['pv', 'load', 'gridKw', 'chargeKw', 'dischargeKw', 'socPct', 'tier']) out[k] = span(a[k], b[k])
  return out
}

/**
 * 隔日預測 + 最佳化排程（頁面三規劃）。
 * 隔日＝今天的下一天（nextDayOf；平常是 2010-07-20、2010-01-12，展示模式跟著播放走），負載、太陽能、天氣、排程都取那一天，
 * 電價也照那一天算（和排程用的一樣，週末不會對不上）。planStamp 是那份排程用哪一版設定算的。
 */
export async function fetchPlanning(day = nextDayOf(getScenario().season)) {
  if (!day) return null // 展示模式播到月底，沒有隔日
  const { season, fixed, pv, weather, plan } = await scenarioInputs(null, day)
  // 展示模式：電價照資料集那天（和排程一致）；平常：真實的明天，切到另一季時換到該季同星期幾
  const date = getDemo().enabled ? parseYmd(day) : scenarioDate(parseYmd(day), season)
  await delay(120)
  return {
    ...simulateDay(date, weather ?? simulateWeather(date), fixed, pv, plan, routineFor(date)),
    season, planDay: day, planStamp: plan?.prefs_stamp ?? null,
    // 建議時間：三台都照建議時 MILP 挑的開機格子與電費（日前排程另外算的；沒有排程就是 null）
    recommended: plan?.recommended ?? null,
  }
}

/**
 * 依使用者手動調整後的排程重新計算電池調度與成本（不重跑 GA）。
 * @param {object} schedule  { deviceId: boolean[96] }
 */
export async function recomputeSchedule(schedule, day = nextDayOf(getScenario().season)) {
  const { season, fixed, pv, weather, plan } = await scenarioInputs(null, day)
  const date = getDemo().enabled ? parseYmd(day) : scenarioDate(parseYmd(day), season)
  await delay(60)
  return {
    ...simulateWithSchedule(date, schedule, weather ?? simulateWeather(date), fixed, pv, plan),
    season,
  }
}
