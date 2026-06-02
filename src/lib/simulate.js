/* ============================================================
   能源模擬引擎（以 15 分鐘為單位，一天 96 時段）

   說明：這是「模擬資料」，用來讓 UI 有真實感。
   實際系統會由 LSTM（太陽能發電預測）、RF 隨機森林（家庭負載預測）與基因演算法（GA 最佳化排程）
   產生這些數值；之後只要把 api/client.js 換成呼叫後端 API 即可，
   本檔案的輸出格式就是 UI 期望的資料結構。
   ============================================================ */
import {
  SLOTS_PER_DAY,
  SLOT_HOURS,
  BATTERY,
  DEVICES,
  slotToHour,
} from './constants.js'
import { isSummer, getPriceSlots, getTierSlots } from './tou.js'
import { nowTaipei } from './time.js'

/* ---- 種子亂數：讓同一天的資料穩定、不會每次 render 都亂跳 ---- */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seedFromDate(date) {
  const start = new Date(date.getFullYear(), 0, 0)
  const day = Math.floor((date - start) / 86400000)
  return date.getFullYear() * 1000 + day
}

/* ============================================================
   1) 太陽能發電預測（kW/時段，鐘形曲線，夜間為 0）
   ============================================================ */
export function pvForecastKw(date) {
  const rng = mulberry32(seedFromDate(date) + 7)
  const summer = isSummer(date)
  const peakKw = summer ? 4.6 : 3.6 // 系統尖峰發電
  const clearness = 0.72 + rng() * 0.28 // 當日晴朗度

  // 台北（約 25°N）的季節日照：夏至約 13.4h、冬至約 10.6h
  const start = new Date(date.getFullYear(), 0, 0)
  const doy = Math.floor((date - start) / 86400000) // 一年中的第幾天
  const daylight = 12 + 1.45 * Math.sin((2 * Math.PI * (doy - 81)) / 365)
  const noon = 12.1 // 台北太陽正午約 12:06
  const sunrise = noon - daylight / 2
  const sunset = noon + daylight / 2
  const sigma = daylight / 4.8

  const out = []
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const h = (s * 15) / 60 // 小時（含小數）
    let kw = 0
    if (h > sunrise && h < sunset) {
      const x = (h - noon) / sigma
      kw = peakKw * clearness * Math.exp(-x * x) * (0.9 + rng() * 0.2) // 雲層擾動
    }
    out.push(Math.max(0, +kw.toFixed(3)))
  }
  return out
}

/* ============================================================
   2) 設備排程與功率
   ============================================================ */

// 不可轉移設備在某小時是否運作
function fixedOn(id, h, summer) {
  switch (id) {
    case 'security':
    case 'fridge':
      return true // 24h 常時
    case 'lighting':
      return (h >= 6 && h < 7.5) || h >= 18
    case 'tv':
      return h >= 19 && h < 23
    case 'computer':
      return (h >= 9 && h < 12) || (h >= 20 && h < 23.5)
    case 'microwave':
      return (h >= 7 && h < 7.5) || (h >= 12 && h < 12.5) || (h >= 18 && h < 18.75)
    case 'ac':
      return summer ? (h >= 13 && h < 17) || h >= 20 : h >= 20 && h < 23.5
    default:
      return false
  }
}

// 設備運轉時的功率（kW），「依排程重算」時也用這個 → 確保可重現
function devicePowerWhenOn(dev, slot) {
  let p = dev.ratedW / 1000
  if (dev.id === 'fridge') p *= 0.4 + 0.6 * Math.abs(Math.sin(slot / 2)) // 壓縮機循環
  else if (dev.category === 'fixed') p *= 0.9
  return +p.toFixed(3)
}

// 可轉移設備的運轉時長（時段數）
const SHIFTABLE_DURATION = {
  washer: 4, // 1.0 h
  dryer: 6, // 1.5 h
  waterHeater: 8, // 2.0 h
  dishwasher: 4, // 1.0 h
}

// 在所有起始點中，依模式選出最佳的連續運轉視窗
function bestWindow(durSlots, mode, price, pv, tier) {
  let best = { start: 0, score: Infinity }
  for (let start = 0; start + durSlots <= SLOTS_PER_DAY; start++) {
    let score = 0
    for (let k = 0; k < durSlots; k++) {
      const i = start + k
      if (mode === 'self') score += -pv[i] // 自用率最大：放在太陽能最多時
      else if (mode === 'peak') score += (tier[i] === 'peak' ? 100 : 0) + price[i] // 避開尖峰
      else score += price[i] // 省錢：最便宜時段
    }
    if (score < best.score) best = { start, score }
  }
  return best.start
}

/** 由演算法產生排程（mode 決定可轉移設備擺放位置） */
export function buildSchedule(date, mode = 'cost') {
  const summer = isSummer(date)
  const price = getPriceSlots(date)
  const tier = getTierSlots(date)
  const pv = pvForecastKw(date)

  const schedule = {}
  for (const dev of DEVICES) schedule[dev.id] = new Array(SLOTS_PER_DAY).fill(false)

  // 不可轉移設備
  for (const dev of DEVICES.filter((d) => d.category === 'fixed')) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      schedule[dev.id][s] = fixedOn(dev.id, (s * 15) / 60, summer)
    }
  }
  // 可轉移設備：放到最佳視窗
  for (const dev of DEVICES.filter((d) => d.category === 'shiftable')) {
    const dur = SHIFTABLE_DURATION[dev.id] ?? 4
    const start = bestWindow(dur, mode, price, pv, tier)
    for (let k = 0; k < dur; k++) schedule[dev.id][start + k] = true
  }
  return schedule
}

/** 由排程算出各設備功率與總負載（手動調整後重算用） */
export function powerAndLoadFromSchedule(schedule) {
  const power = {}
  const total = new Array(SLOTS_PER_DAY).fill(0)
  for (const dev of DEVICES) {
    power[dev.id] = new Array(SLOTS_PER_DAY).fill(0)
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      if (schedule[dev.id]?.[s]) {
        const p = devicePowerWhenOn(dev, s)
        power[dev.id][s] = p
        total[s] += p
      }
    }
  }
  for (let s = 0; s < SLOTS_PER_DAY; s++) total[s] = +total[s].toFixed(3)
  return { power, total }
}

/* ============================================================
   3) 電池 + 電網 調度（核心最佳化模擬）
   ============================================================ */
function shouldPrecharge(mode, slot) {
  if (mode === 'self') return false // 自用率模式不從電網充電
  return slotToHour(slot) < 6 // 省錢 / 舒緩尖峰：深夜離峰預充
}

/** 給定 pv 與 load，計算電池/電網最佳調度 */
export function dispatch(date, mode, pv, load) {
  const price = getPriceSlots(date)
  const tier = getTierSlots(date)

  const cap = BATTERY.capacityKwh
  const minKwh = cap * BATTERY.socMin
  const maxKwh = cap * BATTERY.socMax
  const maxE = BATTERY.maxPowerKw * SLOT_HOURS // 每時段最大充放電能量(kWh)

  let soc = cap * 0.3 // 初始 SOC 30%

  const pvToLoad = [], pvToBatt = [], pvToGrid = []
  const battToLoad = [], gridToLoad = [], gridToBatt = []
  const socPct = []

  let optCost = 0, baseCost = 0
  let tPv = 0, tLoad = 0, tGridImport = 0, tCharge = 0, tDischarge = 0, tReverse = 0

  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const pvE = pv[s] * SLOT_HOURS
    const loadE = load[s] * SLOT_HOURS
    tPv += pvE
    tLoad += loadE

    const p2l = Math.min(pvE, loadE)
    const surplus = pvE - p2l
    const deficit = loadE - p2l
    let p2b = 0, p2g = 0, b2l = 0, g2l = 0, g2b = 0

    // (1) 太陽能剩餘 → 先充電池，滿了才逆送電網
    if (surplus > 0) {
      const room = maxKwh - soc
      const chg = Math.min(surplus, maxE, room)
      p2b = chg
      soc += chg
      p2g = surplus - chg
    }

    // (2) 負載不足 → 尖峰放電池、離峰用電網（並視情況預充）
    if (deficit > 0) {
      if (tier[s] === 'peak') {
        const avail = Math.max(0, soc - minKwh)
        const dis = Math.min(deficit, maxE, avail)
        b2l = dis
        soc -= dis
        g2l = deficit - dis
      } else {
        g2l = deficit
        if (shouldPrecharge(mode, s)) {
          const chg = Math.min(maxE - p2b, maxKwh - soc)
          if (chg > 0) { g2b = chg; soc += chg }
        }
      }
    } else if (shouldPrecharge(mode, s)) {
      const chg = Math.min(maxE - p2b, maxKwh - soc)
      if (chg > 0) { g2b = chg; soc += chg }
    }

    const gridImportE = g2l + g2b
    tGridImport += gridImportE
    tCharge += p2b + g2b
    tDischarge += b2l
    tReverse += p2g
    optCost += gridImportE * price[s]
    baseCost += loadE * price[s] // 基準：無太陽能無電池，全部購電

    pvToLoad.push(+(p2l / SLOT_HOURS).toFixed(3))
    pvToBatt.push(+(p2b / SLOT_HOURS).toFixed(3))
    pvToGrid.push(+(p2g / SLOT_HOURS).toFixed(3))
    battToLoad.push(+(b2l / SLOT_HOURS).toFixed(3))
    gridToLoad.push(+(g2l / SLOT_HOURS).toFixed(3))
    gridToBatt.push(+(g2b / SLOT_HOURS).toFixed(3))
    socPct.push(+((soc / cap) * 100).toFixed(1))
  }

  const chargeKw = pvToBatt.map((v, i) => +(v + gridToBatt[i]).toFixed(3))
  const dischargeKw = battToLoad
  const gridKw = gridToLoad.map((v, i) => +(v + gridToBatt[i]).toFixed(3))
  const battNetKw = chargeKw.map((c, i) => +(c - dischargeKw[i]).toFixed(3))
  const selfUseRate = tPv > 0 ? ((tPv - tReverse) / tPv) * 100 : 0

  return {
    date, mode, slots: SLOTS_PER_DAY,
    pv, load, price, tier,
    pvToLoad, pvToBatt, pvToGrid, battToLoad, gridToLoad, gridToBatt,
    chargeKw, dischargeKw, gridKw, battNetKw, socPct,
    summary: {
      pvKwh: +tPv.toFixed(2),
      loadKwh: +tLoad.toFixed(2),
      gridImportKwh: +tGridImport.toFixed(2),
      chargeKwh: +tCharge.toFixed(2),
      dischargeKwh: +tDischarge.toFixed(2),
      reverseKwh: +tReverse.toFixed(2),
      pvToBattKwh: +pvToBatt.reduce((a, v) => a + v * SLOT_HOURS, 0).toFixed(2),
      gridToBattKwh: +gridToBatt.reduce((a, v) => a + v * SLOT_HOURS, 0).toFixed(2),
      baselineCost: +baseCost.toFixed(1),
      optimizedCost: +optCost.toFixed(1),
      savings: +(baseCost - optCost).toFixed(1),
      savingPct: baseCost > 0 ? +(((baseCost - optCost) / baseCost) * 100).toFixed(1) : 0,
      selfUseRate: +selfUseRate.toFixed(1),
      peakGridKw: +Math.max(...gridKw).toFixed(2),
    },
  }
}

/** 完整模擬一天（演算法排程 + 調度） */
export function simulateDay(date, mode = 'cost') {
  const schedule = buildSchedule(date, mode)
  const { power, total } = powerAndLoadFromSchedule(schedule)
  const pv = pvForecastKw(date)
  const res = dispatch(date, mode, pv, total)
  return { ...res, schedule, devicePower: power }
}

/** 依「指定排程」模擬（手動調整後即時重算） */
export function simulateWithSchedule(date, mode, schedule) {
  const { power, total } = powerAndLoadFromSchedule(schedule)
  const pv = pvForecastKw(date)
  const res = dispatch(date, mode, pv, total)
  return { ...res, schedule, devicePower: power }
}

/* ============================================================
   4) 即時快照（給主頁面 KPI / 頁面二設備卡用）
   ============================================================ */
export function liveSnapshot(now = nowTaipei()) {
  const day = simulateDay(now, 'cost')
  const slot = Math.min(
    SLOTS_PER_DAY - 1,
    Math.floor((now.getHours() * 60 + now.getMinutes()) / 15)
  )
  const jitter = () => 0.95 + Math.random() * 0.1

  const devices = DEVICES.map((dev) => {
    const on = day.schedule[dev.id][slot]
    const base = day.devicePower[dev.id][slot]
    const watt = on ? Math.round(base * 1000 * jitter()) : 0
    let status = on ? 'on' : 'off'
    if (!on && (dev.id === 'fridge' || dev.id === 'security')) status = 'standby'
    return { ...dev, watt, status }
  })

  const totalLoadKw = devices.reduce((a, d) => a + d.watt / 1000, 0)

  return {
    slot,
    pvKw: +(day.pv[slot] * jitter()).toFixed(2),
    loadKw: +totalLoadKw.toFixed(2),
    chargeKw: day.chargeKw[slot],
    dischargeKw: day.dischargeKw[slot],
    battNetKw: day.battNetKw[slot],
    gridKw: +(day.gridKw[slot] * jitter()).toFixed(2),
    socPct: day.socPct[slot],
    socKwh: +((day.socPct[slot] / 100) * BATTERY.capacityKwh).toFixed(2),
    price: day.price[slot],
    tier: day.tier[slot],
    devices,
    savingsToday: day.summary.savings,
    summary: day.summary,
  }
}
