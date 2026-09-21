/* ============================================================
   模擬引擎的健全性檢查：npm run check

   UI 上的電池調度、排程、防逆送、天氣都是 src/lib 裡的純函式算出來的，
   改了這些檔案之後跑一次，確認沒有把物理上不可能的結果畫到畫面上：
     1. 即時快照的能量平衡（太陽能＋放電＋購電＝負載＋充電）、不出現負值、放電中不削太陽能
     2. 整日調度：SOC 在上下限內、充放電不超過電池功率、購電不為負
     3. 可轉移設備只在允許時段運轉、烘衣機排在洗衣機之後、每台剛好運轉一次
     4. 夏月／非夏月情境換日期時星期幾不變、季節正確
     5. 14 天 ERA5 天氣都轉得出來，天空狀況與實際日照一致
     6. 排程組的排程（schedule.json）：用排程時的負載與太陽能執行，結果要和排程一致；
        只套用在電價相符的日子（週末不套用）
   資料用 public/data 的快照（和網頁同一份），不需要連資料庫。有任何一項不過就回傳錯誤碼 1。
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const lib = (f) => import(pathToFileURL(path.join(ROOT, 'src', 'lib', f)).href)
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8'))

const { liveSnapshot, simulateDay, dispatchPlan, planFits, SHIFTABLE_RULES, isAllowedSlot } = await lib('simulate.js')
const { weatherFromEra5 } = await lib('weather.js')
const { scenarioDate, seasonOf } = await lib('scenario.js')
const { BATTERY, SLOTS_PER_DAY } = await lib('constants.js')

const snaps = { summer: readJson('forecast_day.json'), non_summer: readJson('forecast_day_non_summer.json') }
const wx = readJson('weather.json')
const hist = readJson('history.json')
const plans = Object.fromEntries(readJson('schedule.json').schedules.map((s) => [s.date, s]))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `　${detail}` : ''}`)
  if (!ok) failed++
}

// 和 api/client.js 相同：未來用前一晚 23:45 的日前預測（有排程時用排程的 load_kw，否則用 history.json 的 day_ahead），過去用真實值
const dayAhead = (d) => plans[d.target_date]?.load_kw
  ?? hist.days.find((x) => x.date === d.target_date)?.day_ahead ?? d.slots
const assemble = (d, s) => dayAhead(d).map((v, i) => (i <= s ? (d.actual[i] ?? v) : v))

const DAYS = [['平日', 14], ['週六', 19]] // 2026-09-14 週一、09-19 週六

for (const [season, snap] of Object.entries(snaps)) {
  const weather = weatherFromEra5(wx.days[snap.target_date], snap.target_date)
  const plan = plans[snap.target_date] ?? null
  for (const [label, dom] of DAYS) {
    console.log(`\n[${season === 'summer' ? '夏月' : '非夏月'}・${label}]　資料集 ${snap.target_date}`
      + `・電池${plan ? '有排程組排程' : '無排程（模擬調度）'}`)
    const base = new Date(2026, 8, dom, 12, 0)
    const at0 = scenarioDate(base, season)
    check('情境日期：季節正確、星期幾不變', seasonOf(at0) === season && at0.getDay() === base.getDay(),
      at0.toDateString())

    // ---- 1. 即時快照 ----
    let worst = 0, negatives = 0, cutWhileDischarging = 0
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const at = scenarioDate(new Date(2026, 8, dom, Math.floor(s / 4), (s % 4) * 15), season)
      for (let k = 0; k < 10; k++) {
        const v = liveSnapshot(at, assemble(snap, s), snap.pv, weather, plan)
        worst = Math.max(worst, Math.abs(v.pvKw + v.dischargeKw + v.gridKw - v.loadKw - v.chargeKw))
        if ([v.pvKw, v.dischargeKw, v.gridKw, v.chargeKw, v.curtailKw].some((x) => x < 0)) negatives++
        if (v.curtailKw > 0.005 && v.dischargeKw > 0.005) cutWhileDischarging++
      }
    }
    check('即時快照能量平衡', worst < 0.011, `最大誤差 ${worst.toFixed(3)} kW`)
    check('即時快照沒有負值', negatives === 0, `${negatives} 次`)
    check('電池放電時不削減太陽能', cutWhileDischarging === 0, `${cutWhileDischarging} 次`)

    // ---- 2. 整日調度 ----
    check('日前預測有 96 格', dayAhead(snap).length === SLOTS_PER_DAY && dayAhead(snap) !== snap.slots)
    const sim = simulateDay(at0, weather, dayAhead(snap), snap.pv, plan)
    if (plan) {
      const weekday = at0.getDay() >= 1 && at0.getDay() <= 5
      check(weekday ? '平日電價相符：電池照排程' : '週末電價不同：不套用排程',
        weekday ? sim.planSource !== 'sim' : sim.planSource === 'sim', `planSource=${sim.planSource}`)
    }
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
    if (sim.planSource !== 'sim') {
      // 套用排程組排程的日子不排可轉移設備，負載要和排程一致
      const anyOn = Object.keys(SHIFTABLE_RULES).some((id) => sim.schedule[id].some(Boolean))
      check('套用排程時不排可轉移設備', !anyOn)
      const worstLoad = Math.max(...sim.load.map((v, i) => Math.abs(v - plan.load_kw[i])))
      check('總負載等於排程的負載', worstLoad < 0.002, `最大差 ${worstLoad.toFixed(4)} kW`)
      continue
    }
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

// ---- 6. 排程組的排程 ----
for (const plan of Object.values(plans)) {
  console.log(`\n[排程組排程]　${plan.date}（${plan.solver ?? '—'}）`)
  const d = new Date(`${plan.date}T12:00:00`)
  check('電價與排程日相符', planFits(plan, d))
  // 用排程當時的負載與太陽能執行，功率、購電、SOC 都應和排程一致
  const r = dispatchPlan(d, plan.pv_kw, plan.load_kw, plan)
  const worst = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
  check('電池功率和排程一致', worst(r.battNetKw, plan.batt_kw) < 0.01, `最大差 ${worst(r.battNetKw, plan.batt_kw).toFixed(3)} kW`)
  check('購電和排程一致', worst(r.gridKw, plan.grid_buy_kw) < 0.01, `最大差 ${worst(r.gridKw, plan.grid_buy_kw).toFixed(3)} kW`)
  check('SOC 和排程一致', worst(r.socPct, plan.soc_pct) < 0.1, `最大差 ${worst(r.socPct, plan.soc_pct).toFixed(2)}%`)
  const cost = plan.grid_buy_kw.reduce((a, g, i) => a + g * plan.price[i] * 0.25, 0)
  check('電費和排程一致', Math.abs(r.summary.optimizedCost - cost) < 0.1,
    `${r.summary.optimizedCost} 元（排程 ${cost.toFixed(2)}）`)
  // 負載比預測高 20%／低 20% 時仍守住物理限制
  for (const k of [0.8, 1.2]) {
    const x = dispatchPlan(d, plan.pv_kw, plan.load_kw.map((v) => v * k), plan)
    const ok = Math.min(...x.gridKw) >= 0
      // 排程可能從保留區（15% 以下）開始：前一天的可轉移設備用掉了，期限前才充回
      && Math.min(...x.socPct) >= BATTERY.socFloor * 100 - 0.05 && Math.max(...x.socPct) <= BATTERY.socMax * 100 + 0.05
      && Math.max(...x.chargeKw, ...x.dischargeKw) <= BATTERY.maxPowerKw + 1e-6
    check(`負載 ×${k}：購電不為負、SOC 與功率在限制內`, ok,
      `SOC ${Math.min(...x.socPct)}～${Math.max(...x.socPct)}%`)
  }
}

// ---- 5. 天氣 ----
console.log('\n[天氣]')
let mismatch = 0
// 歷史紀錄與發電量預測都有一整年，天氣只抓了兩個展示週，所以以有天氣的日子為準
const showDays = hist.days.filter((d) => wx.days[d.date])
for (const d of showDays) {
  const w = weatherFromEra5(wx.days[d.date], d.date)
  const pv = d.pv_actual ?? []
  // 白天（09–15 時）標成「晴」的格子，發電量不該低得像陰天；標成「陰」的，不該發得像晴天
  for (let p = 3; p < 5; p++) {
    const period = w.summary.periods[p]
    const kwh = pv.slice(p * 12, p * 12 + 12).reduce((a, v) => a + (v ?? 0), 0) * 0.25
    if ((period.label === '晴' && kwh < 3) || (period.label === '陰' && kwh > 8)) mismatch++
  }
}
check('有天氣的日子都在歷史紀錄裡', showDays.length === Object.keys(wx.days).length,
  `天氣 ${Object.keys(wx.days).length} 天、對得上歷史紀錄 ${showDays.length} 天（歷史紀錄共 ${hist.days.length} 天）`)
check('白天的晴／陰標籤和實際發電一致', mismatch === 0, `不一致 ${mismatch} 格`)

console.log(failed ? `\n有 ${failed} 項沒有通過` : '\n全部通過')
process.exit(failed ? 1 : 0)
