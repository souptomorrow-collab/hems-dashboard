/* 使用者對可轉移設備的設定（唯一會寫回雲端的東西）

   讀：GET /prefs（沒設 VITE_API_BASE 或讀不到就用這台裝置的 localStorage）
   寫：POST /prefs，需要金鑰 VITE_PREFS_KEY（建置時由 GitHub Actions 變數帶入）

   為什麼金鑰放在前端還可以：後端那個端點只能寫 hems.user_prefs 的一份文件，
   設備代號限定三個、欄位限定 enabled 與 deadline，其餘一律 400；
   寫入用的資料庫帳號也只有這個集合的權限。最壞情況是有人改了設定，覆蓋回來即可。

   設備代號一律用英文（washer／dryer／dishwasher）：Vercel 轉發 POST 內容時會弄壞 UTF-8，
   中文鍵值傳不過來。中文名稱由 GET /prefs 的 names 欄位提供。

   存的是使用者在甘特圖上拖出來的運轉時段：
     {"washer": {"enabled": true, "slots": [["18:00", "19:00"]]}}
   排程照這個時段跑；沒有 slots（或 enabled 為 false）的設備不運轉，排程不替使用者挑時間。 */

const ENV = import.meta.env ?? {}
const API = String(ENV.VITE_API_BASE ?? '').replace(/\/+$/, '')
const KEY = String(ENV.VITE_PREFS_KEY ?? '')
const LOCAL = 'hems-device-prefs'
const TIMEOUT_MS = 8000

export const DEVICE_IDS = ['washer', 'dryer', 'dishwasher']
export const DEFAULT_PREFS = Object.fromEntries(DEVICE_IDS.map((id) => [id, { enabled: true }]))

const hhmm = (slot) => `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`

/** 甘特圖的 96 格 true/false → [["18:00", "19:00"], …]（連續的併成一段，24:00 收尾） */
export function toSegments(row) {
  if (!Array.isArray(row)) return []
  const out = []
  let start = null
  for (let i = 0; i <= row.length; i++) {
    if (row[i] && start === null) start = i
    else if (!row[i] && start !== null) {
      out.push([hhmm(start), i === 96 ? '24:00' : hhmm(i)])
      start = null
    }
  }
  return out
}

/** [["18:00", "19:00"], …] → 96 格 true/false */
export function toRow(segments) {
  const row = new Array(96).fill(false)
  for (const [a, b] of segments ?? []) {
    const s = Number(a.slice(0, 2)) * 4 + Number(a.slice(3)) / 15
    const e = b === '24:00' ? 96 : Number(b.slice(0, 2)) * 4 + Number(b.slice(3)) / 15
    for (let i = s; i < e && i < 96; i++) row[i] = true
  }
  return row
}

/** 有沒有辦法寫回雲端（沒有就只存這台裝置） */
export const canSave = Boolean(API && KEY)

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeLocal(devices) {
  try {
    localStorage.setItem(LOCAL, JSON.stringify(devices))
  } catch {
    /* 無痕視窗等情況寫不進去，不影響這次操作 */
  }
}

async function call(path, init) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(API + path, { ...init, signal: ctrl.signal, cache: 'no-store' })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.detail ?? `HTTP ${r.status}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

/** 存到雲端之後發出的事件（detail.stamp＝這次設定的版本）。整月檢視收到就開始追蹤本機重算的進度 */
export const PREFS_SAVED = 'hems:prefs-saved'

/** 目前的設定。回傳 { devices, source: 'cloud' | 'local' | 'default', updatedAt, stamp }
    stamp 是設定的版本，和排程、實時運轉每天記的 prefs_stamp 同格式 */
export async function loadPrefs() {
  if (API) {
    try {
      const d = await call('/prefs')
      if (d.devices && Object.keys(d.devices).length) {
        writeLocal(d.devices)
        return { devices: d.devices, source: 'cloud', updatedAt: d.updated_at ?? null, stamp: d.stamp ?? null }
      }
    } catch (e) {
      console.warn('讀取雲端設定失敗，改用本機：', e.message)
    }
  }
  const local = readLocal()
  return local
    ? { devices: local, source: 'local', updatedAt: null, stamp: null }
    : { devices: DEFAULT_PREFS, source: 'default', updatedAt: null, stamp: null }
}

/** 儲存設定。一律先存這台裝置，再試著寫回雲端。
    回傳 { saved: 'cloud' | 'local', error } */
export async function savePrefs(devices) {
  writeLocal(devices)
  if (!canSave) return { saved: 'local', error: null }
  try {
    const r = await call('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
      body: JSON.stringify({ devices }),
    })
    const stamp = r.stamp ?? null
    window.dispatchEvent(new CustomEvent(PREFS_SAVED, { detail: { stamp } }))
    return { saved: 'cloud', error: null, stamp }
  } catch (e) {
    return { saved: 'local', error: e.message }
  }
}
