/* ============================================================
   能源模擬引擎（以 15 分鐘為單位，一天 96 時段）

   說明：太陽能與不可轉移負載有雲端預測時用預測（LSTM、RF），
   電池有排程組的排程（MILP，public/data/schedule.json）且當天電價相符時照排程充放電
   （dispatchPlan），其餘部分用這裡的模擬補上，讓 UI 每一天都有完整的資料。
   本檔案的輸出格式就是 UI 期望的資料結構。

   天氣（src/lib/weather.js）會影響：
   - 太陽能發電：雲量越多、發電越低（陰雨/颱風驟降）
   - 家庭負載：氣溫越高、冷氣用電越多；陰雨天白天也開燈
   有真實資料時用資料集那一天台北的 ERA5 天氣，讀不到才用模擬天氣。
   ============================================================ */
import { SLOTS_PER_DAY, SLOT_HOURS, BATTERY, DEVICES, slotToHour, UNASSIGNED } from './constants.js'
import { isSummer, getPriceSlots, getTierSlots } from './tou.js'
import { nowTaipei } from './time.js'
import { mulberry32, seedFromDate, dayOfYear } from './rng.js'
import { simulateWeather } from './weather.js'

/* ============================================================
   1) 太陽能發電預測（kW/時段）= 晴空鐘形曲線 × 天氣衰減
   ============================================================ */
export function pvForecastKw(date, weather = simulateWeather(date)) {
  const rng = mulberry32(seedFromDate(date) + 7)
  const summer = isSummer(date)
  const peakKw = summer ? 4.6 : 3.6 // 系統晴空尖峰發電

  // 台北（約 25°N）的季節日照：夏至約 13.4h、冬至約 10.6h
  const doy = dayOfYear(date)
  const daylight = 12 + 1.45 * Math.sin((2 * Math.PI * (doy - 81)) / 365)
  const noon = 12.1 // 台北太陽正午約 12:06
  const sunrise = noon - daylight / 2
  const sunset = noon + daylight / 2
  const sigma = daylight / 4.8

  const out = []
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const h = (s * 15) / 60
    let kw = 0
    if (h > sunrise && h < sunset) {
      const x = (h - noon) / sigma
      const clearSky = peakKw * Math.exp(-x * x) // 晴空理論發電
      const atten = weather.attenSlots[s] ?? 1 // 天氣衰減（雲量/降雨）
      kw = clearSky * atten * (0.97 + rng() * 0.06)
    }
    out.push(Math.max(0, +kw.toFixed(3)))
  }
  return out
}

/* ============================================================
   2) 設備排程與功率
   ============================================================ */

// 不可轉移設備在某時段是否運作（受天氣影響：高溫→冷氣多、陰雨→白天開燈）
function fixedOn(id, slot, summer, weather) {
  const h = (slot * 15) / 60
  const tmax = weather?.summary?.tempMax ?? (summer ? 33 : 22)
  const dark = (weather?.attenSlots?.[slot] ?? 1) < 0.45 // 陰雨天白天偏暗
  switch (id) {
    case 'security':
    case 'fridge':
      return true // 24h 常時
    case 'lighting':
      if ((h >= 6 && h < 8) || h >= 18) return true
      if (dark && h >= 8 && h < 18) return true // 陰雨天白天留一盞燈
      return false
    case 'tv':
      return h >= 19 && h < 23
    case 'computer':
      return h >= 20 && h < 23.5 // 晚上在家才用
    case 'microwave':
      return (h >= 7 && h < 7.5) || (h >= 18 && h < 18.75) // 早餐、晚餐
    case 'ac':
      if (summer) {
        // 雙薪外出型：白天沒人，傍晚回家才開冷氣
        let on = h >= 18 && h < 24
        if (tmax > 34) on = on || (h >= 16 && h < 18) // 特別熱才提早開
        return on
      }
      // 非夏季：僅較暖的日子，傍晚才開
      if (tmax <= 26) return false
      return h >= 19 && h < 24
    default:
      return false
  }
}

// 設備運轉時的功率（kW）；冷氣會隨氣溫提高
function devicePowerWhenOn(dev, slot, weather) {
  let p = dev.ratedW / 1000
  if (dev.id === 'fridge') {
    // 900 W 是壓縮機額定；換算成 6~10% 的等效工作週期（平均約 76 W，一天約 1.8 度，接近一般家用冰箱）
    p *= 0.06 + 0.04 * Math.abs(Math.sin(slot))
  } else if (dev.id === 'ac') {
    const t = weather?.tempSlots?.[slot] ?? 28
    const f = Math.max(0.45, Math.min(1.0, (t - 24) / 9 + 0.55)) // 越熱功率越高，額定為上限
    p *= f
  } else if (dev.category === 'fixed') {
    p *= 0.9
  }
  return +p.toFixed(3)
}

/* 可轉移設備的運轉條件（UI 模擬排程用的作息假設）
   dur      一次運轉幾格（15 分鐘一格）
   windows  允許運轉的時段 [起, 迄)（小時），整段運轉都要落在裡面
   after    要等哪一台跑完才能開始
   洗衣機、烘衣機避開深夜（運轉聲會吵到鄰居），烘衣機得等洗衣機洗完；
   洗碗機是晚餐後放進去，可以延到隔天清晨前洗完。
   原本沒有這些限制，排程只看電價，會把洗衣機排到凌晨 00:00 開始洗。 */
export const SHIFTABLE_RULES = {
  washer: { dur: 4, windows: [[6, 22]], text: '06:00–22:00' },
  dryer: { dur: 6, windows: [[6, 23]], after: 'washer', text: '06:00–23:00，接在洗衣機之後' },
  dishwasher: { dur: 4, windows: [[0, 7], [19, 24]], text: '19:00～隔天 07:00' },
}

/** 第 slot 格是否在該設備允許運轉的時段內（沒有規則的設備一律允許） */
export function isAllowedSlot(devId, slot) {
  const rule = SHIFTABLE_RULES[devId]
  if (!rule) return true
  const h = slot / 4
  return rule.windows.some(([a, b]) => h >= a && h < b)
}

// 在允許的起始點中選出最便宜的連續運轉視窗；沒有可行的就回 -1
// occupancy：各時段已被其他可轉移設備佔用的數量，用來避免多台同時運轉
// earliest：最早從第幾格開始（接在另一台後面的設備用）
function bestWindow(devId, durSlots, price, occupancy, earliest = 0) {
  let best = { start: -1, score: Infinity }
  for (let start = earliest; start + durSlots <= SLOTS_PER_DAY; start++) {
    let ok = true
    let score = 0
    for (let k = 0; k < durSlots && ok; k++) {
      const i = start + k
      ok = isAllowedSlot(devId, i)
      score += price[i] // 電費最小化：挑最便宜的時段
      score += (occupancy?.[i] ?? 0) * 1.0 // 避免多台設備同時運轉（分散負載）
    }
    if (ok && score < best.score) best = { start, score }
  }
  return best.start
}

/** 由演算法產生排程：把可轉移設備排到電價最低的時段。
   withShiftable=false 時只排不可轉移設備（套用排程組排程的日子：MILP 沒有排可轉移設備，
   UI 也不自行加入，負載與購電才和排程組一致；使用者仍可在用電規劃頁手動排入） */
export function buildSchedule(date, weather = simulateWeather(date), withShiftable = true) {
  const summer = isSummer(date)
  const price = getPriceSlots(date)

  const schedule = {}
  for (const dev of DEVICES) schedule[dev.id] = new Array(SLOTS_PER_DAY).fill(false)

  // 不可轉移設備
  for (const dev of DEVICES.filter((d) => d.category === 'fixed')) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      schedule[dev.id][s] = fixedOn(dev.id, s, summer, weather)
    }
  }
  // 可轉移設備：在允許時段內放到最便宜的視窗，並避免互相重疊（分散負載，不會全擠在同一時刻）。
  // 順序：沒有前置條件的先排（長的先放），要接在別台後面的最後排
  if (!withShiftable) return schedule
  const occupancy = new Array(SLOTS_PER_DAY).fill(0)
  const endOf = {}
  const shiftables = DEVICES.filter((d) => d.category === 'shiftable').sort((a, b) => {
    const ra = SHIFTABLE_RULES[a.id] ?? {}
    const rb = SHIFTABLE_RULES[b.id] ?? {}
    if (Boolean(ra.after) !== Boolean(rb.after)) return ra.after ? 1 : -1
    return (rb.dur ?? 4) - (ra.dur ?? 4)
  })
  for (const dev of shiftables) {
    const rule = SHIFTABLE_RULES[dev.id] ?? { dur: 4 }
    const earliest = rule.after ? (endOf[rule.after] ?? 0) : 0
    const start = bestWindow(dev.id, rule.dur, price, occupancy, earliest)
    if (start < 0) continue // 當天排不進去就不運轉
    for (let k = 0; k < rule.dur; k++) {
      schedule[dev.id][start + k] = true
      occupancy[start + k]++
    }
    endOf[dev.id] = start + rule.dur
  }
  return schedule
}

/** 由排程算出各設備功率與總負載（手動調整後重算用）
   並分開「不可轉移（RF 預測對象）」與「可轉移（排程決定）」兩部分。

   fixedOverride：96 格的**真實 RF 預測**（kW）。給了就用它取代模擬的
   不可轉移負載，各不可轉移設備依比例縮放以吻合該總量。
   RF 模型預測的是不可轉移負載的「總量」，本來就拆不出各設備；
   這裡的比例縮放只是為了讓頁面二的設備堆疊圖仍加總得起來，
   屬於顯示用的分解，不是模型輸出。 */
export function powerAndLoadFromSchedule(schedule, weather = null, fixedOverride = null) {
  const power = {}
  const total = new Array(SLOTS_PER_DAY).fill(0)
  const fixed = new Array(SLOTS_PER_DAY).fill(0) // 不可轉移：RF 預測
  const shiftable = new Array(SLOTS_PER_DAY).fill(0) // 可轉移：排程決定
  for (const dev of DEVICES) {
    power[dev.id] = new Array(SLOTS_PER_DAY).fill(0)
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      if (schedule[dev.id]?.[s]) {
        const p = devicePowerWhenOn(dev, s, weather)
        power[dev.id][s] = p
        total[s] += p
        if (dev.category === 'fixed') fixed[s] += p
        else shiftable[s] += p
      }
    }
  }

  power.unassigned = new Array(SLOTS_PER_DAY).fill(0)

  // 以真實預測取代模擬的不可轉移負載
  if (fixedOverride?.length === SLOTS_PER_DAY) {
    const fixedDevs = DEVICES.filter((d) => d.category === 'fixed')
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const target = Math.max(0, +fixedOverride[s])
      if (!Number.isFinite(target)) continue
      const sim = fixed[s]
      if (sim > 0.01) {
        const k = target / sim
        for (const dev of fixedDevs) power[dev.id][s] = +(power[dev.id][s] * k).toFixed(4)
        // 縮放後可能有設備超過自己的額定；把超出的部分讓給還有餘裕、且正在運轉的設備，
        // 總量不變，但每台顯示的功率不會高於額定值
        let extra = 0
        const room = []
        for (const dev of fixedDevs) {
          const cap = (dev.capW ?? dev.ratedW) / 1000
          if (power[dev.id][s] > cap) {
            extra += power[dev.id][s] - cap
            power[dev.id][s] = cap
          } else if (power[dev.id][s] > 0) {
            room.push([dev.id, cap - power[dev.id][s]])
          }
        }
        const roomSum = room.reduce((a, [, r]) => a + r, 0)
        if (extra > 1e-6 && roomSum > 1e-6) {
          const give = Math.min(extra, roomSum)
          for (const [id, r] of room) {
            power[id][s] = +(power[id][s] + give * (r / roomSum)).toFixed(4)
          }
          extra -= give
        }
        // 所有設備都到合理上限後還放不下的部分歸到「未分項」，各設備加總才會等於總負載
        if (extra > 1e-6) power.unassigned[s] = +extra.toFixed(4)
      } else {
        // 理論上不會發生（冰箱/監控 24h 常開）；保險起見先給常時設備到上限，剩下歸未分項
        let left = target
        for (const dev of fixedDevs.filter((d) => d.id === 'fridge' || d.id === 'security')) {
          const give = Math.min(left, (dev.capW ?? dev.ratedW) / 1000)
          power[dev.id][s] = +give.toFixed(4)
          left -= give
        }
        if (left > 1e-6) power.unassigned[s] = +left.toFixed(4)
      }
      total[s] = total[s] - sim + target
      fixed[s] = target
    }
  }

  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    total[s] = +total[s].toFixed(3)
    fixed[s] = +fixed[s].toFixed(3)
    shiftable[s] = +shiftable[s].toFixed(3)
  }
  return { power, total, fixed, shiftable }
}

/* ============================================================
   3) 電池 + 電網 調度（核心最佳化模擬）
   ============================================================ */
function shouldPrecharge(slot) {
  return slotToHour(slot) < 6 // 深夜離峰電價最低，先把電池充起來
}

/** 給定 pv 與 load，計算電池/電網最佳調度 */
export function dispatch(date, pv, load) {
  const price = getPriceSlots(date)
  const tier = getTierSlots(date)

  const cap = BATTERY.capacityKwh
  const minKwh = cap * BATTERY.socMin
  const maxKwh = cap * BATTERY.socMax
  const maxE = BATTERY.maxPowerKw * SLOT_HOURS // 每時段最大充放電能量(kWh)

  let soc = cap * BATTERY.socInit // 初始 SOC（計畫書更新版：15%）

  // 預充上限：保留白天「預期太陽能剩餘」可充入的空間，
  // 避免半夜用電網把電池充滿、導致白天太陽能無處可存（只能逆送）。
  // 夏季太陽能多 → 幾乎不從電網預充，改由太陽能日充、傍晚尖峰夜放。
  let expectedSurplus = 0
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    expectedSurplus += Math.max(0, pv[s] - load[s]) * SLOT_HOURS
  }
  const reserve = Math.min(expectedSurplus, maxKwh - minKwh)
  // 預充只是為了尖峰要用的電：當天沒有尖峰（週末、假日整天離峰）就不預充，
  // 否則半夜買的電一整天放不出去，裝了 HEMS 反而比較貴。
  // 要預充的量 = 尖峰時段的缺口 − 白天太陽能可以補進電池的量
  let peakDeficit = 0
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    if (tier[s] === 'peak') peakDeficit += Math.max(0, load[s] - pv[s]) * SLOT_HOURS
  }
  const needFromGrid = Math.max(0, peakDeficit - expectedSurplus)
  const prechargeCeiling = Math.max(minKwh, Math.min(maxKwh - reserve, minKwh + needFromGrid))
  // 預充平均分散到所有預充時段（00:00–06:00），不要一開始就用最大功率充：
  // 都是離峰電價所以電費一樣，但半夜向電網買電不會衝出尖刺，充放電也比較平緩
  let prechargeSlots = 0
  for (let s = 0; s < SLOTS_PER_DAY; s++) if (shouldPrecharge(s)) prechargeSlots++
  const prechargeRate = prechargeSlots > 0
    ? Math.min(maxE, Math.max(0, prechargeCeiling - soc) / prechargeSlots)
    : 0

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
        if (shouldPrecharge(s)) {
          const chg = Math.min(maxE - p2b, prechargeRate, prechargeCeiling - soc)
          if (chg > 0) { g2b = chg; soc += chg }
        }
      }
    } else if (shouldPrecharge(s)) {
      const chg = Math.min(maxE - p2b, prechargeRate, prechargeCeiling - soc)
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

  return pack(date, pv, load, price, tier,
    { pvToLoad, pvToBatt, pvToGrid, battToLoad, gridToLoad, gridToBatt, socPct },
    { tPv, tLoad, tGridImport, tCharge, tDischarge, tReverse, optCost, baseCost })
}

/* ------------------------------------------------------------
   依排程組的排程執行（MILP 結果，public/data/schedule.json）

   排程給的是每格的電池功率（正＝充電）與 SOC。這裡照那份功率充放電，
   實際負載、太陽能和排程時用的預測不同時，差額由實時運轉的規則處理：
     - 放電不超過當格的用電缺口（防逆送：降低電池輸出）
     - 比預期多出來的太陽能先充進電池，電池滿了或到功率上限才削減
     - 其餘差額由電網補足
   電池模型與排程組相同：充電時計入往返效率損失，放電不再扣。
   只有當天電價和排程時用的電價一致時才套用（例如週末電價不同就不套用）。
   ------------------------------------------------------------ */

/** 這份排程能不能用在 date 這一天（格數正確、電價逐格一致） */
export function planFits(plan, date) {
  if (!plan || plan.batt_kw?.length !== SLOTS_PER_DAY || plan.price?.length !== SLOTS_PER_DAY) return false
  const price = getPriceSlots(date)
  return price.every((p, i) => Math.abs(p - plan.price[i]) < 0.005)
}

export function dispatchPlan(date, pv, load, plan) {
  const price = getPriceSlots(date)
  const tier = getTierSlots(date)

  const cap = BATTERY.capacityKwh
  const minKwh = cap * BATTERY.socMin
  const maxKwh = cap * BATTERY.socMax
  const maxE = BATTERY.maxPowerKw * SLOT_HOURS
  const eff = BATTERY.roundTrip
  let soc = cap * BATTERY.socInit

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
    let surplus = pvE - p2l
    const deficit = loadE - p2l
    let p2b = 0, b2l = 0, g2b = 0

    const cmd = (plan.batt_kw[s] ?? 0) * SLOT_HOURS // kWh，正＝充電
    if (cmd > 0) {
      const chg = Math.max(0, Math.min(cmd, maxE, (maxKwh - soc) / eff))
      p2b = Math.min(surplus, chg) // 先用太陽能充，不夠的才向電網買
      g2b = chg - p2b
      surplus -= p2b
      soc += chg * eff
    } else if (cmd < 0) {
      b2l = Math.max(0, Math.min(-cmd, deficit, soc - minKwh))
      soc -= b2l
    }

    // 排程本來就預期要削減的太陽能（排程時電池已到上限或功率上限）
    const planCut = Math.max(0, ((plan.pv_kw?.[s] ?? 0) - (plan.pv_used_kw?.[s] ?? 0)) * SLOT_HOURS)
    // 比預期多出來的部分先充進電池
    const unexpected = Math.max(0, surplus - planCut)
    if (unexpected > 0) {
      const extra = Math.max(0, Math.min(unexpected, maxE - p2b - g2b, (maxKwh - soc) / eff))
      p2b += extra
      surplus -= extra
      soc += extra * eff
    }
    const p2g = surplus // 剩下的：防逆送削減
    const g2l = deficit - b2l

    const gridImportE = g2l + g2b
    tGridImport += gridImportE
    tCharge += p2b + g2b
    tDischarge += b2l
    tReverse += p2g
    optCost += gridImportE * price[s]
    baseCost += loadE * price[s]

    pvToLoad.push(+(p2l / SLOT_HOURS).toFixed(3))
    pvToBatt.push(+(p2b / SLOT_HOURS).toFixed(3))
    pvToGrid.push(+(p2g / SLOT_HOURS).toFixed(3))
    battToLoad.push(+(b2l / SLOT_HOURS).toFixed(3))
    gridToLoad.push(+(g2l / SLOT_HOURS).toFixed(3))
    gridToBatt.push(+(g2b / SLOT_HOURS).toFixed(3))
    socPct.push(+((soc / cap) * 100).toFixed(1))
  }

  return pack(date, pv, load, price, tier,
    { pvToLoad, pvToBatt, pvToGrid, battToLoad, gridToLoad, gridToBatt, socPct },
    { tPv, tLoad, tGridImport, tCharge, tDischarge, tReverse, optCost, baseCost })
}

/** 兩種調度共用：由逐格能量流組出 UI 要的欄位與當日摘要 */
function pack(date, pv, load, price, tier, flows, t) {
  const { pvToLoad, pvToBatt, pvToGrid, battToLoad, gridToLoad, gridToBatt, socPct } = flows
  const { tPv, tLoad, tGridImport, tCharge, tDischarge, tReverse, optCost, baseCost } = t
  const chargeKw = pvToBatt.map((v, i) => +(v + gridToBatt[i]).toFixed(3))
  const dischargeKw = battToLoad
  const gridKw = gridToLoad.map((v, i) => +(v + gridToBatt[i]).toFixed(3))
  const battNetKw = chargeKw.map((c, i) => +(c - dischargeKw[i]).toFixed(3))
  const selfUseRate = tPv > 0 ? ((tPv - tReverse) / tPv) * 100 : 0

  return {
    date, slots: SLOTS_PER_DAY,
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

/** 電池調度：有適用的排程組排程就照排程，否則用上面的模擬調度 */
function runDispatch(date, pv, load, plan) {
  if (plan && planFits(plan, date)) {
    return { ...dispatchPlan(date, pv, load, plan), planSource: plan.solver ?? 'plan', planDate: plan.date }
  }
  return {
    ...dispatch(date, pv, load),
    planSource: 'sim',
    // 有排程但這天電價不同（例如週末）→ 說明為什麼沒套用
    planNote: plan ? '當天電價與排程不同，電池改用模擬調度' : null,
  }
}

/** 完整模擬一天（演算法排程 + 調度），含天氣
   fixedOverride：真實 RF 不可轉移負載預測（96 格 kW），沒給就用模擬值
   pvOverride：真實 LSTM 發電量預測（96 格 kW），沒給就用模擬的晴空曲線
   plan：排程組的排程（schedule.json 的一份），有給且電價相符時電池照排程充放電 */
export function simulateDay(
  date,
  weather = simulateWeather(date),
  fixedOverride = null,
  pvOverride = null,
  plan = null
) {
  const pv = pvOverride ?? pvForecastKw(date, weather)
  const schedule = buildSchedule(date, weather, !(plan && planFits(plan, date)))
  const { power, total, fixed, shiftable } = powerAndLoadFromSchedule(
    schedule,
    weather,
    fixedOverride
  )
  const res = runDispatch(date, pv, total, plan)
  return {
    ...res,
    schedule,
    devicePower: power,
    fixedLoad: fixed,
    shiftableLoad: shiftable,
    weather,
    loadSource: fixedOverride ? 'rf' : 'sim',
    pvSource: pvOverride ? 'lstm' : 'sim',
  }
}

/** 依「指定排程」模擬（手動調整後即時重算）。
   有排程組的排程時電池仍照排程，手動移動設備只改變電網購電與電費 */
export function simulateWithSchedule(
  date,
  schedule,
  weather = simulateWeather(date),
  fixedOverride = null,
  pvOverride = null,
  plan = null
) {
  const pv = pvOverride ?? pvForecastKw(date, weather)
  const { power, total, fixed, shiftable } = powerAndLoadFromSchedule(
    schedule,
    weather,
    fixedOverride
  )
  const res = runDispatch(date, pv, total, plan)
  return {
    ...res,
    schedule,
    devicePower: power,
    fixedLoad: fixed,
    shiftableLoad: shiftable,
    weather,
    loadSource: fixedOverride ? 'rf' : 'sim',
    pvSource: pvOverride ? 'lstm' : 'sim',
  }
}

/* ============================================================
   4) 即時快照（給主頁面 KPI / 頁面二設備卡用）
   ============================================================ */
export function liveSnapshot(
  now = nowTaipei(),
  fixedOverride = null,
  pvOverride = null,
  weather = simulateWeather(now),
  plan = null
) {
  const day = simulateDay(now, weather, fixedOverride, pvOverride, plan)
  const slot = Math.min(
    SLOTS_PER_DAY - 1,
    Math.floor((now.getHours() * 60 + now.getMinutes()) / 15)
  )
  const jitter = () => 0.95 + Math.random() * 0.1

  const devices = DEVICES.map((dev) => {
    const on = day.schedule[dev.id][slot]
    const base = day.devicePower[dev.id][slot]
    // 擾動後仍夾在額定功率以內，畫面上不會出現「即時功率大於額定」
    const watt = on ? Math.min(dev.ratedW, Math.round(base * 1000 * jitter())) : 0
    let status = on ? 'on' : 'off'
    if (!on && (dev.id === 'fridge' || dev.id === 'security')) status = 'standby'
    return { ...dev, watt, status }
  })
  // 未分項：預測總量裡無法歸到特定設備的部分，要算進總負載，畫面上的數字才加得起來
  const un = day.devicePower.unassigned?.[slot] ?? 0
  if (un > 0.005) devices.push({ ...UNASSIGNED, watt: Math.round(un * 1000 * jitter()), status: 'on' })

  const totalLoadKwRaw = devices.reduce((a, d) => a + d.watt / 1000, 0)

  /* ----------------------------------------------------------
     能量平衡：PV + 電池放電 + 電網購電 = 家庭負載 + 電池充電

     PV 與各設備負載都各自帶了隨機擾動（模擬量測誤差），若電網側
     也獨立乘一次擾動，畫面上四個數字就會加不起來。電網是系統中
     吸收不平衡的一端，因此必須「由平衡式推得」，不能自己抖。

     電池充放電維持排程的指令值不抖動（電池是追隨設定點的）。
     ---------------------------------------------------------- */
  const r2 = (v) => Math.round(v * 100) / 100
  const loadKw = r2(totalLoadKwRaw)
  const chargeKw = r2(day.chargeKw[slot])
  let dischargeKw = r2(day.dischargeKw[slot])
  const pvPotentialKw = r2(day.pv[slot] * jitter()) // 未削減前的可發電量
  let pvKw = pvPotentialKw
  let gridKw = r2(loadKw + chargeKw - pvKw - dischargeKw)

  /* 防逆送：不可將多餘電力送回台電電網，過剩時由實時運轉層吸收。
     吸收順序：先收斂電池放電，不夠才削減太陽能。
     太陽能是免費的、削掉就沒了；少放的電則留在電池裡，晚點還能用。
     原本先削太陽能，傍晚電池正在放電時會出現「防逆送削減」，等於把免費的電丟掉。
     每一步都夾在 0 以上，放電與太陽能都不會被減成負值。 */
  let curtailKw = 0
  if (gridKw < 0) {
    let surplus = -gridKw
    const less = Math.min(surplus, dischargeKw) // 電池放電最多只能收到 0
    dischargeKw = r2(dischargeKw - less)
    surplus = r2(surplus - less)
    if (surplus > 0) {
      const cut = Math.min(surplus, pvKw) // 太陽能最多只能削到 0
      pvKw = r2(pvKw - cut)
      curtailKw = r2(cut)
    }
    gridKw = 0
  }

  return {
    slot,
    pvKw,
    pvPotentialKw,
    loadKw,
    chargeKw,
    dischargeKw,
    curtailKw,
    battNetKw: day.battNetKw[slot],
    gridKw,
    socPct: day.socPct[slot],
    socKwh: +((day.socPct[slot] / 100) * BATTERY.capacityKwh).toFixed(2),
    price: day.price[slot],
    tier: day.tier[slot],
    devices,
    savingsToday: day.summary.savings,
    summary: day.summary,
    loadSource: day.loadSource,
    pvSource: day.pvSource,
    planSource: day.planSource,
    weather: day.weather.hourly[now.getHours()],
    weatherSummary: day.weather.summary,
  }
}
