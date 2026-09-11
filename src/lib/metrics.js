/* ============================================================
   預測誤差指標與日用電統計（歷史紀錄頁用）

   只計入「預測與真實都有值」的格子；任一邊缺值就跳過那格，
   不把缺值當 0 算進去（那會把誤差灌大）。
   ============================================================ */
import { SLOT_HOURS } from './constants.js'

function pairs(pred, actual) {
  const out = []
  for (let i = 0; i < Math.min(pred.length, actual.length); i++) {
    const p = pred[i]
    const a = actual[i]
    if (Number.isFinite(p) && Number.isFinite(a)) out.push([p, a])
  }
  return out
}

/** 平均絕對誤差（kW） */
export function mae(pred, actual) {
  const ps = pairs(pred, actual)
  return ps.length ? ps.reduce((s, [p, a]) => s + Math.abs(p - a), 0) / ps.length : null
}

/** 均方根誤差（kW）：大誤差懲罰較重，和 MAE 一起看才知道誤差是平均還是偶發暴衝 */
export function rmse(pred, actual) {
  const ps = pairs(pred, actual)
  return ps.length ? Math.sqrt(ps.reduce((s, [p, a]) => s + (p - a) ** 2, 0) / ps.length) : null
}

/**
 * 平均絕對百分比誤差（%）。
 * 真實值接近 0 的格子分母太小，一格就能讓 MAPE 爆掉，照慣例排除（< 0.05 kW）。
 */
export function mape(pred, actual, floor = 0.05) {
  const ps = pairs(pred, actual).filter(([, a]) => Math.abs(a) >= floor)
  return ps.length ? (ps.reduce((s, [p, a]) => s + Math.abs((p - a) / a), 0) / ps.length) * 100 : null
}

/** 一天的用電量（kWh）：每格是 15 分鐘平均功率，乘上 0.25 小時再加總 */
export function energyKwh(series) {
  return series.reduce((s, v) => s + (Number.isFinite(v) ? v * SLOT_HOURS : 0), 0)
}

/** 尖峰：{ kw, slot } */
export function peak(series) {
  let best = { kw: -Infinity, slot: 0 }
  series.forEach((v, i) => {
    if (Number.isFinite(v) && v > best.kw) best = { kw: v, slot: i }
  })
  return best
}
