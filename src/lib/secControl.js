/* 實時運轉層的每秒控制：照排程組 realmilp_3.py 的 step_1sec_control（device_plan/scripts/run_realtime.py 逐秒呼叫）逐行移植。
   網頁用拿得到的資料逐秒重算：每秒負載（含運轉中的可轉移設備）與太陽能、本格排程目標（該格重排計畫的第 1 格）、
   上一格結束時的電量與累計誤差（actual_operation 的 soc_pct、err_kwh）。
   和資料庫的實時運轉紀錄比對過（2010/01/11、07/19、07/31）：每格平均最大差約 0.02 kW（排程目標與電量在資料裡有四捨五入）。 */

const CAP = 13.5 // 電池容量 kWh
const PMAX = 5 // 最大充放電功率 kW
const ETA = 0.9 // 充電效率
const DT = 1 / 3600 // 1 秒（小時）
const SOC_MIN = 0.15
const SOC_MAX = 0.9
const ERR_MAX = 0.5 // 累計誤差上限 ±0.5 度

/** 一秒：回傳 { batt（正＝充電）, grid, curt, soc, err, last } */
export function step(sched, pv, load, soc, err, last) {
  const maxChg = Math.min(PMAX, Math.max(0, ((SOC_MAX - soc) * CAP) / (DT * ETA)))
  const maxDis = Math.min(PMAX, Math.max(0, ((soc - SOC_MIN) * CAP) / DT))
  // 誤差補償：上一秒沒跟上指令 → 補上一秒落差的 10%；有跟上 → 補累計誤差的 10%
  const comp = Math.abs(last) > 0.0001 ? -last * 0.1 : -(err / DT) * 0.1
  const desired = sched + comp
  // 防逆送：至少吸收「太陽能－負載」，再限制在這一秒的充放電上限
  const target = Math.max(-maxDis, Math.min(maxChg, Math.max(desired, pv - load)))
  const batt = target // 模擬中電池完全照指令運轉
  const g = load + batt - pv
  const curt = g < 0 ? -g : 0
  let s = soc + (batt > 0 ? batt * DT * ETA : batt * DT) / CAP
  s = Math.max(SOC_MIN, Math.min(SOC_MAX, s))
  const e = Math.max(-ERR_MAX, Math.min(ERR_MAX, err + (batt - sched) * DT))
  return { batt, grid: Math.max(g, 0), curt, soc: s, err: e, last: batt - target }
}

/**
 * 一格（15 分鐘）從開頭跑到 upto 秒（含）：load、pv 是整天的每秒陣列，slot 是第幾格，dev 是這格設備功率，
 * target 是排程目標，soc0／err0 是上一格結束時的電量（0～1）與累計誤差。回傳逐秒的陣列與這格到 upto 為止的統計。
 */
export function simulateSlot({ load, pv, slot, upto, dev, target, soc0, err0 }) {
  const t0 = slot * 900
  const end = Math.min(upto, t0 + 899)
  const out = { t0, batt: [], grid: [], curt: [], net: [], err: [] }
  let soc = soc0
  let err = err0
  let last = 0
  let surplus = 0
  let absorbed = 0
  for (let i = t0; i <= end; i++) {
    const L = load[i] + dev
    const P = pv[i]
    const r = step(target, P, L, soc, err, last)
    soc = r.soc; err = r.err; last = r.last
    out.batt.push(r.batt); out.grid.push(r.grid); out.curt.push(r.curt); out.net.push(L - P); out.err.push(r.err)
    const sp = Math.max(0, P - L)
    surplus += sp
    absorbed += Math.min(sp, Math.max(0, r.batt))
  }
  const n = out.batt.length || 1
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  out.stats = {
    battAvg: sum(out.batt) / n,
    gridKwh: sum(out.grid) * DT,
    curtKwh: sum(out.curt) * DT,
    surplusKwh: surplus * DT,
    absorbedKwh: absorbed * DT,
    battKwh: sum(out.batt) * DT, // 正＝充入
    planKwh: target * n * DT,
    err,
    soc,
  }
  return out
}
