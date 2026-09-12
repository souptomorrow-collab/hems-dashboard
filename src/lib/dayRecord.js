/* ============================================================
   單日紀錄：把一天的模擬結果（simulateDay 的輸出）整理成歷史頁要的數字

   simulateDay 每一格都有六條能量流（kW），這裡全部乘上 0.25 小時換成度數：
     pvToLoad   太陽能 → 家裡用       battToLoad 電池 → 家裡用
     pvToBatt   太陽能 → 充進電池     gridToLoad 電網 → 家裡用
     pvToGrid   太陽能多出來的部分    gridToBatt 電網 → 充進電池
   本系統設定「防逆送」（多的電不能賣回台電），pvToGrid 實際上是被削減、
   沒有被利用的太陽能，所以標成「削減」而不是「賣電」。
   ============================================================ */
import { DEVICES, BATTERY, SLOT_HOURS, SLOTS_PER_DAY, slotToTime } from './constants.js'

const kwh = (arr) => arr.reduce((a, v) => a + v * SLOT_HOURS, 0)

/** 布林陣列中連續為 true 的區段 → [{start, end}]（end 為最後一格的下一格） */
function runsOf(flags) {
  const out = []
  let s = null
  flags.forEach((on, i) => {
    if (on && s === null) s = i
    if (!on && s !== null) { out.push({ start: s, end: i }); s = null }
  })
  if (s !== null) out.push({ start: s, end: flags.length })
  return out
}

export function dayRecord(sim) {
  const n = SLOTS_PER_DAY
  const gridIn = sim.gridToLoad.map((v, i) => v + sim.gridToBatt[i]) // 每格向電網買的功率

  /* ---- 電費拆解：依尖峰／離峰分組，裝了 HEMS vs 沒裝（全部向台電買） ---- */
  const tou = {}
  for (let s = 0; s < n; s++) {
    const t = sim.tier[s]
    tou[t] ??= { tier: t, slots: 0, price: sim.price[s], hemsKwh: 0, hemsCost: 0, baseKwh: 0, baseCost: 0 }
    const g = tou[t]
    g.slots += 1
    g.hemsKwh += gridIn[s] * SLOT_HOURS
    g.hemsCost += gridIn[s] * SLOT_HOURS * sim.price[s]
    g.baseKwh += sim.load[s] * SLOT_HOURS
    g.baseCost += sim.load[s] * SLOT_HOURS * sim.price[s]
  }
  const touRows = Object.values(tou).sort((a, b) => b.price - a.price) // 尖峰（貴）排前面

  /* ---- 能源來源與去向 ---- */
  const load = kwh(sim.load)
  const pv = kwh(sim.pv)
  const sources = [
    { key: 'pv', label: '太陽能', kwh: kwh(sim.pvToLoad) },
    { key: 'batt', label: '電池', kwh: kwh(sim.battToLoad) },
    { key: 'grid', label: '電網', kwh: kwh(sim.gridToLoad) },
  ]
  const pvDest = [
    { key: 'self', label: '直接自用', kwh: kwh(sim.pvToLoad) },
    { key: 'batt', label: '充進電池', kwh: kwh(sim.pvToBatt) },
    { key: 'cut', label: '削減（防逆送）', kwh: kwh(sim.pvToGrid) },
  ]

  /* ---- 設備用電排行 ---- */
  const devices = DEVICES.map((d) => ({ ...d, kwh: kwh(sim.devicePower[d.id]) }))
    .filter((d) => d.kwh > 0.001)
    .sort((a, b) => b.kwh - a.kwh)

  /* ---- 可轉移設備被排在什麼時候 ---- */
  const runs = DEVICES.filter((d) => d.category === 'shiftable').map((d) => ({
    ...d,
    runs: runsOf(sim.schedule[d.id]).map((r) => {
      const slots = Array.from({ length: r.end - r.start }, (_, k) => r.start + k)
      const peakSlots = slots.filter((s) => sim.tier[s] === 'peak').length
      return {
        ...r,
        from: slotToTime(r.start),
        to: r.end >= n ? '24:00' : slotToTime(r.end),
        kwh: slots.reduce((a, s) => a + sim.devicePower[d.id][s] * SLOT_HOURS, 0),
        cost: slots.reduce((a, s) => a + sim.devicePower[d.id][s] * SLOT_HOURS * sim.price[s], 0),
        allOffpeak: peakSlots === 0,
      }
    }),
  }))

  /* ---- 電池 ---- */
  const usable = BATTERY.capacityKwh * (BATTERY.socMax - BATTERY.socMin)
  const soc = sim.socPct
  const socMaxAt = soc.indexOf(Math.max(...soc))
  const socMinAt = soc.indexOf(Math.min(...soc))
  const battery = {
    chargeKwh: kwh(sim.chargeKw),
    fromPvKwh: kwh(sim.pvToBatt),
    fromGridKwh: kwh(sim.gridToBatt),
    dischargeKwh: kwh(sim.dischargeKw),
    // 等效滿循環：放出的電量相當於把可用容量從上限放到下限幾次（電池壽命以此計）
    cycles: kwh(sim.dischargeKw) / usable,
    socMax: soc[socMaxAt], socMaxAt: slotToTime(socMaxAt),
    socMin: soc[socMinAt], socMinAt: slotToTime(socMinAt),
  }

  const gridBought = kwh(gridIn)

  return {
    summary: sim.summary,
    load, pv, gridBought,
    touRows, sources, pvDest, devices, runs, battery,
  }
}
