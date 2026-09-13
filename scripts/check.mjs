/* ============================================================
   模擬引擎的健全性檢查：npm run check

   UI 上的電池調度、排程、防逆送、天氣都是 src/lib 裡的純函式算出來的，
   改了這些檔案之後跑一次，確認沒有把物理上不可能的結果畫到畫面上：
     1. 即時快照的能量平衡（太陽能＋放電＋購電＝負載＋充電）、不出現負值、放電中不削太陽能
     2. 整日調度：SOC 在上下限內、充放電不超過電池功率、購電不為負
     3. 可轉移設備只在允許時段運轉、烘衣機排在洗衣機之後、每台剛好運轉一次
     4. 夏月／非夏月情境換日期時星期幾不變、季節正確
     5. 14 天 ERA5 天氣都轉得出來，天空狀況與實際日照一致
   資料用 public/data 的快照（和網頁同一份），不需要連資料庫。有任何一項不過就回傳錯誤碼 1。
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const lib = (f) => import(pathToFileURL(path.join(ROOT, 'src', 'lib', f)).href)
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8'))

const { liveSnapshot, simulateDay, SHIFTABLE_RULES, isAllowedSlot } = await lib('simulate.js')
const { weatherFromEra5 } = await lib('weather.js')
const { scenarioDate, seasonOf } = await lib('scenario.js')
const { BATTERY, SLOTS_PER_DAY } = await lib('constants.js')

const snaps = { summer: readJson('forecast_day.json'), non_summer: readJson('forecast_day_non_summer.json') }
const wx = readJson('weather.json')
const hist = readJson('history.json')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `　${detail}` : ''}`)
  if (!ok) failed++
}

// 和 api/client.js 的 assembleFixed 相同：過去用真實值、未來用第 s 格發布的預測
const assemble = (d, s) => Array.from({ length: SLOTS_PER_DAY }, (_, i) =>
  i <= s ? (d.actual[i] ?? d.slots[i]) : (d.rolling[s]?.[i - s - 1] ?? d.slots[i]))

const DAYS = [['平日', 14], ['週六', 19]] // 2026-09-14 週一、09-19 週六

for (const [season, snap] of Object.entries(snaps)) {
  const weather = weatherFromEra5(wx.days[snap.target_date], snap.target_date)
  for (const [label, dom] of DAYS) {
    console.log(`\n[${season === 'summer' ? '夏月' : '非夏月'}・${label}]　資料集 ${snap.target_date}`)
    const base = new Date(2026, 8, dom, 12, 0)
    const at0 = scenarioDate(base, season)
    check('情境日期：季節正確、星期幾不變', seasonOf(at0) === season && at0.getDay() === base.getDay(),
      at0.toDateString())

    // ---- 1. 即時快照 ----
    let worst = 0, negatives = 0, cutWhileDischarging = 0
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const at = scenarioDate(new Date(2026, 8, dom, Math.floor(s / 4), (s % 4) * 15), season)
      for (let k = 0; k < 10; k++) {
        const v = liveSnapshot(at, assemble(snap, s), snap.pv, weather)
        worst = Math.max(worst, Math.abs(v.pvKw + v.dischargeKw + v.gridKw - v.loadKw - v.chargeKw))
        if ([v.pvKw, v.dischargeKw, v.gridKw, v.chargeKw, v.curtailKw].some((x) => x < 0)) negatives++
        if (v.curtailKw > 0.005 && v.dischargeKw > 0.005) cutWhileDischarging++
      }
    }
    check('即時快照能量平衡', worst < 0.011, `最大誤差 ${worst.toFixed(3)} kW`)
    check('即時快照沒有負值', negatives === 0, `${negatives} 次`)
    check('電池放電時不削減太陽能', cutWhileDischarging === 0, `${cutWhileDischarging} 次`)

    // ---- 2. 整日調度 ----
    const sim = simulateDay(at0, weather, snap.slots, snap.pv)
    const socLo = Math.min(...sim.socPct), socHi = Math.max(...sim.socPct)
    check('SOC 在上下限內', socLo >= BATTERY.socMin * 100 - 0.05 && socHi <= BATTERY.socMax * 100 + 0.05,
      `${socLo}%～${socHi}%`)
    const maxRate = Math.max(...sim.chargeKw, ...sim.dischargeKw)
    check('充放電不超過電池功率', maxRate <= BATTERY.maxPowerKw + 1e-6, `最大 ${maxRate} kW`)
    check('購電不為負', Math.min(...sim.gridKw) >= 0)
    check('電費不為負、省下 ≤ 不裝系統的電費',
      sim.summary.optimizedCost >= 0 && sim.summary.savings <= sim.summary.baselineCost,
      `${sim.summary.optimizedCost} 元（不裝 ${sim.summary.baselineCost}）`)

    // ---- 3. 可轉移設備排程 ----
    const runs = {}
    for (const id of Object.keys(SHIFTABLE_RULES)) {
      const on = sim.schedule[id]
      const slots = on.flatMap((v, i) => (v ? [i] : []))
      runs[id] = slots
      const contiguous = slots.every((v, i) => i === 0 || v === slots[i - 1] + 1)
      check(`${id} 只運轉一次、長度正確`, contiguous && slots.length === SHIFTABLE_RULES[id].dur,
        `${slots.length} 格`)
      check(`${id} 都在允許時段內`, slots.every((s) => isAllowedSlot(id, s)))
    }
    check('烘衣機排在洗衣機洗完之後', runs.dryer[0] >= runs.washer[runs.washer.length - 1] + 1)
  }
}

// ---- 5. 天氣 ----
console.log('\n[天氣]')
let mismatch = 0
for (const d of hist.days) {
  const w = weatherFromEra5(wx.days[d.date], d.date)
  const pv = d.pv_actual ?? []
  // 白天（09–15 時）標成「晴」的格子，發電量不該低得像陰天；標成「陰」的，不該發得像晴天
  for (let p = 3; p < 5; p++) {
    const period = w.summary.periods[p]
    const kwh = pv.slice(p * 12, p * 12 + 12).reduce((a, v) => a + (v ?? 0), 0) * 0.25
    if ((period.label === '晴' && kwh < 3) || (period.label === '陰' && kwh > 8)) mismatch++
  }
}
check('14 天天氣都有資料', hist.days.every((d) => wx.days[d.date]), `${Object.keys(wx.days).length} 天`)
check('白天的晴／陰標籤和實際發電一致', mismatch === 0, `不一致 ${mismatch} 格`)

console.log(failed ? `\n有 ${failed} 項沒有通過` : '\n全部通過')
process.exit(failed ? 1 : 0)
