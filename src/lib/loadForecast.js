/* ============================================================
   不可轉移負載預測 — 資料整形與誤差指標

   RF 模型預測的是「不可轉移負載」的**總量**（kW，每 15 分鐘平均功率）：
     不可轉移負載 = 整戶總用電 − 三個可轉移分錶（廚房／洗衣／熱水器+空調）
   也就是 GA 排程一定要被滿足、無法挪移的基礎用電。

   UI 端需要的是 96 格（0~95）的一日陣列，所以這裡把 96 步預測
   依 target_time 的「一日中時段」歸位。因為一個 refresh 剛好帶未來 24 小時，
   96 步會完整鋪滿 0~95 一輪（跨午夜的部分自動接回開頭），不會有空格。
   ============================================================ */
import { SLOTS_PER_DAY } from './constants.js'
import { wallToSlot, parseWall } from '../api/supabase.js'

/**
 * 96 步預測 → 96 格一日陣列（index = 一日中的第幾個 15 分鐘）
 * @param {Array} rows  load_forecast 的列（需含 target_time, predicted_load_kw）
 * @returns {number[]|null} 96 個 kW 值；資料不足時回 null
 */
export function forecastToSlots(rows) {
  if (!rows?.length) return null
  const out = new Array(SLOTS_PER_DAY).fill(null)
  for (const r of rows) {
    const s = wallToSlot(r.target_time)
    out[s] = +Number(r.predicted_load_kw).toFixed(3)
  }
  // 萬一某格缺值（refresh 不完整），用前後鄰居補，避免圖上斷線
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    if (out[s] == null) {
      const prev = out[(s - 1 + SLOTS_PER_DAY) % SLOTS_PER_DAY]
      const next = out[(s + 1) % SLOTS_PER_DAY]
      out[s] = prev != null && next != null ? +((prev + next) / 2).toFixed(3) : (prev ?? next ?? 0)
    }
  }
  return out
}

/** 真實值列 → 以 "YYYY-MM-DD HH:MM" 為 key 的查表 */
export function actualIndex(rows) {
  const map = new Map()
  for (const r of rows ?? []) {
    const w = parseWall(r.time)
    if (w) map.set(`${w.date} ${w.time}`, +Number(r.actual_load_kw).toFixed(3))
  }
  return map
}

/**
 * 把預測列對上真實值，產生「照 lead_step 排序」的比對序列。
 * @returns {{ labels, predicted, actual, leads }}
 */
export function alignPredictedActual(forecastRows, actualMap) {
  const labels = []
  const predicted = []
  const actual = []
  const leads = []
  for (const r of forecastRows ?? []) {
    const w = parseWall(r.target_time)
    if (!w) continue
    labels.push(w.time)
    leads.push(r.lead_step)
    predicted.push(+Number(r.predicted_load_kw).toFixed(3))
    const a = actualMap.get(`${w.date} ${w.time}`)
    actual.push(a ?? null)
  }
  return { labels, predicted, actual, leads }
}

/* ------------------------------------------------------------
   誤差指標
   ------------------------------------------------------------ */

/**
 * MAE / RMSE / R² / MAPE。只計入 actual 有值的點。
 * R² 以真實值的變異數為基準（與離線評估 core/evaluate.py 一致）。
 */
export function metrics(predicted, actual) {
  const pairs = []
  for (let i = 0; i < predicted.length; i++) {
    const p = predicted[i]
    const a = actual[i]
    if (p != null && a != null && Number.isFinite(p) && Number.isFinite(a)) pairs.push([p, a])
  }
  const n = pairs.length
  if (!n) return null

  let sumAbs = 0
  let sumSq = 0
  let sumA = 0
  let sumPct = 0
  let pctN = 0
  for (const [p, a] of pairs) {
    const e = p - a
    sumAbs += Math.abs(e)
    sumSq += e * e
    sumA += a
    if (Math.abs(a) > 0.05) {
      // 分母太小的點（近乎零負載）會讓 MAPE 爆掉，照慣例排除
      sumPct += Math.abs(e / a)
      pctN++
    }
  }
  const mean = sumA / n
  let ssTot = 0
  for (const [, a] of pairs) ssTot += (a - mean) * (a - mean)

  return {
    n,
    mae: +(sumAbs / n).toFixed(4),
    rmse: +Math.sqrt(sumSq / n).toFixed(4),
    r2: ssTot > 0 ? +(1 - sumSq / ssTot).toFixed(4) : null,
    mape: pctN ? +((sumPct / pctN) * 100).toFixed(2) : null,
    meanActual: +mean.toFixed(3),
  }
}

/** 各 lead_step 的絕對誤差（看「預測愈遠愈不準」的曲線） */
export function errorByLead(leads, predicted, actual) {
  const out = []
  for (let i = 0; i < leads.length; i++) {
    const p = predicted[i]
    const a = actual[i]
    out.push({
      lead: leads[i],
      err: p != null && a != null ? +Math.abs(p - a).toFixed(4) : null,
    })
  }
  return out.sort((x, y) => x.lead - y.lead)
}

/* ------------------------------------------------------------
   快取：同一個 refresh 在多個頁面/元件重複要資料時只打一次 API
   ------------------------------------------------------------ */
const cache = new Map()

export function cached(key, loader) {
  if (!cache.has(key)) {
    cache.set(
      key,
      loader().catch((e) => {
        cache.delete(key) // 失敗不留壞值，下次可重試
        throw e
      })
    )
  }
  return cache.get(key)
}
