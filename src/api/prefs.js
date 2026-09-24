/* 使用者對可轉移設備的設定（唯一會寫回雲端的東西）

   讀：GET /prefs（沒設 VITE_API_BASE 或讀不到就用這台裝置的 localStorage）
   寫：POST /prefs，需要金鑰 VITE_PREFS_KEY（建置時由 GitHub Actions 變數帶入）

   為什麼金鑰放在前端還可以：後端那個端點只能寫 hems.user_prefs 的一份文件，
   設備代號限定三個、欄位限定 enabled、earliest、deadline、slots，其餘一律 400；
   寫入用的資料庫帳號也只有這個集合的權限。最壞情況是有人改了設定，覆蓋回來即可。

   設備代號一律用英文（washer／dryer／dishwasher）：Vercel 轉發 POST 內容時會弄壞 UTF-8，
   中文鍵值傳不過來。中文名稱由 GET /prefs 的 names 欄位提供。

   流程（2026-09-23 定案：滾動決定、開機才定案；沒排就不開、只排明天）：
   使用者設的是條件，幾點開由排程決定
     {"washer": {"enabled": true}, "dryer": {"enabled": false},
      "dishwasher": {"enabled": true, "slots": [["20:00", "21:00"]]}}
   enabled true 且沒給範圍＝照建議；earliest／deadline＝最早開始、最晚完成；slots＝指定時間；
   enabled false 或沒列出＝那天不開。兩種排法：
     明日排程（mode day）     只管隔日那一天（by_date.<隔日>），後天照常駐排程
     常駐排程（mode standing）從隔日起同一個月每天都用這份（standing），取代隔日以後的舊排法
   日前排程先排出預估時間，實時層每 15 分鐘重排，排到「現在開」才開機。條件的換算見 lib/deviceJobs.js。 */

const ENV = import.meta.env ?? {}
const API = String(ENV.VITE_API_BASE ?? '').replace(/\/+$/, '')
const KEY = String(ENV.VITE_PREFS_KEY ?? '')
const LOCAL = 'hems-device-prefs'
const TIMEOUT_MS = 8000

export const DEVICE_IDS = ['washer', 'dryer', 'dishwasher']
/** 讀不到雲端也沒有本機紀錄時（只有展示模式會讀設定）：用展示月的假設「這位客戶每天都照建議排三台」，
    和資料庫的 devices、快照裡的排程一致。沒列出的設備才是沒排（不開） */
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

/** 存到雲端之後發出的事件（detail.stamp＝這次設定的版本、detail.from＝從哪天起生效）。
    用電規劃頁收到就等本機把隔日照這一版重排好 */
export const PREFS_SAVED = 'hems:prefs-saved'

/** 目前的設定。date 給資料集日期就是那天的條件（用電規劃頁給隔日）。
    回傳 { devices, from, mode, standingFrom, source: 'cloud' | 'local' | 'default', updatedAt, stamp, changedFrom }
    devices：各設備的條件（沒列出的＝不開）；from：那天是明日排程就是那天；
    mode：那天用的是 'day'（明日排程）還是 'standing'（常駐排程；沒排過常駐就是展示月的假設）
    stamp 是設定的版本，和排程、實時運轉每天記的 prefs_stamp 同格式；
    changedFrom 是最近一次改的是哪天起（null＝原本的設定整個換掉，兩個月整月重排） */
export async function loadPrefs(date = null) {
  if (API) {
    try {
      const d = await call(date ? `/prefs?date=${date}` : '/prefs')
      return {
        devices: d.devices ?? {}, from: d.from ?? null,
        mode: d.mode === 'day' ? 'day' : 'standing', standingFrom: d.standing_from ?? null,
        source: 'cloud', updatedAt: d.updated_at ?? null,
        stamp: d.stamp ?? null, changedFrom: d.changed_from ?? null,
      }
    } catch (e) {
      console.warn('讀取雲端設定失敗，改用本機：', e.message)
    }
  }
  const local = readLocal()
  const none = { from: null, mode: 'standing', standingFrom: null, updatedAt: null, stamp: null, changedFrom: null }
  return local ? { ...none, devices: local, source: 'local' } : { ...none, devices: DEFAULT_PREFS, source: 'default' }
}

/** 儲存設定。from＝隔日的資料集日期；mode＝'day'（明日排程，只管那天）或 'standing'（常駐排程，從那天起每天）。
    一律先存這台裝置，再試著寫回雲端。回傳 { saved: 'cloud' | 'local', error, stamp, from } */
export async function savePrefs(devices, from = null, mode = 'day') {
  writeLocal(devices)
  if (!canSave) return { saved: 'local', error: null }
  try {
    const r = await call('/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
      body: JSON.stringify(from ? { devices, from, mode } : { devices }),
    })
    const stamp = r.stamp ?? null
    window.dispatchEvent(new CustomEvent(PREFS_SAVED, { detail: { stamp, from: r.from ?? from } }))
    return { saved: 'cloud', error: null, stamp, from: r.from ?? from }
  } catch (e) {
    return { saved: 'local', error: e.message }
  }
}

/** 網頁開著：告訴本機的待命程式（device_plan/scripts/demo_agent.py）有人在用，它會叫起排程監看；
    網頁每分鐘送一次，停了 30 分鐘它就把監看程式關掉。不管在哪一台電腦打開網頁都有效（這台電腦要開著、有跑待命程式）。
    nextDay＝網頁現在的隔日：隔日還是舊設定算的，排程監看就只補算那一天（實務上每天只排隔日；月底沒有隔日給 null）。
    回傳有沒有送成功 */
export async function pingDemo(nextDay = null) {
  if (!canSave) return false
  try {
    await call('/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
      body: JSON.stringify(nextDay ? { next_day: nextDay } : {}),
    })
    return true
  } catch (e) {
    console.warn('展示訊號送不出去：', e.message)
    return false
  }
}
