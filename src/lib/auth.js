/* ============================================================
   登入與角色（住戶／管理員）

   ⚠️ 這是前端登入，只用來區分畫面，不是資安保護：
   網站放在 GitHub Pages、沒有後端，帳密只能寫在前端程式裡。這裡只存「鹽＋密碼」的
   SHA-256 雜湊，原始碼看不到密碼本身；但懂技術的人仍可改瀏覽器儲存的登入狀態繞過，
   短密碼的雜湊也猜得出來，public/data 的資料檔更是直接就能下載。
   要真的保護資料，得另外架後端做帳號驗證，並把資料改由後端提供。

   修改或新增帳號：npm run hash-password -- <帳號> <密碼>，把印出的那一行貼到 ACCOUNTS。
   role 決定看得到什麼：
     resident  住戶：主頁面、各負載、用電規劃、歷史紀錄；不顯示預測模型相關的圖與資料來源
     admin     管理員：全部，加上預測模型圖、情境切換、展示模式、系統資訊頁
   ============================================================ */
import { useSyncExternalStore } from 'react'

export const ACCOUNTS = [
  { username: 'resident', role: 'resident', label: '住戶', salt: 'e0d292d4b951ebec9a84a036', hash: 'ce4b4c2272a7b39bbf9a64c9027deaca58921f0a25d3579c50e2f841e36de312' },
  { username: 'admin', role: 'admin', label: '管理員', salt: '67be99a185bc72eab51009f7', hash: '96ae723698409959eeb33962887811d513d6cdb9542440544e165db705b74bb9' },
]

const KEY = 'hems-session'
const REMEMBER_DAYS = 30
const listeners = new Set()

// 沒勾「保持登入」存在 sessionStorage（關掉瀏覽器就登出），有勾存在 localStorage。
// 無痕視窗或封鎖網站資料時讀寫會丟例外：那就只在這次開著的頁面裡保持登入
function storages() {
  const out = []
  try { out.push(sessionStorage) } catch { /* 無法使用 */ }
  try { out.push(localStorage) } catch { /* 無法使用 */ }
  return out
}

/** 讀出已儲存的登入狀態；帳號不存在、角色對不上或已過期都當作沒登入 */
function readSession() {
  for (const st of storages()) {
    try {
      const raw = st.getItem(KEY)
      if (!raw) continue
      const v = JSON.parse(raw)
      const acc = ACCOUNTS.find((a) => a.username === v.username && a.role === v.role)
      if (acc && (!v.expires || v.expires > Date.now())) {
        return { username: acc.username, role: acc.role, label: acc.label }
      }
    } catch {
      // 內容壞掉就當沒登入
    }
  }
  return null
}

let current = readSession()

function emit() {
  listeners.forEach((fn) => fn())
}

// 另一個分頁登出（或登入）時，這個分頁跟著更新
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return
    current = readSession()
    emit()
  })
} catch {
  // 非瀏覽器環境
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 登入。成功回傳 { ok: true }，失敗回傳 { ok: false, message }。
 * @param {boolean} remember 在這台裝置保持登入 30 天
 */
export async function login(username, password, remember = false) {
  if (!globalThis.crypto?.subtle) {
    return { ok: false, message: '這個環境無法驗證密碼，請改用 https 網址開啟網站' }
  }
  const acc = ACCOUNTS.find((a) => a.username === username)
  // 帳號不存在也照樣算一次雜湊，回應時間不會透露帳號是否存在
  const hash = await sha256Hex((acc?.salt ?? 'no-such-account') + password)
  if (!acc || hash !== acc.hash) {
    await new Promise((r) => setTimeout(r, 400)) // 稍微拖慢，連續亂試比較費時
    return { ok: false, message: '帳號或密碼不正確' }
  }
  const value = JSON.stringify({
    username: acc.username,
    role: acc.role,
    expires: remember ? Date.now() + REMEMBER_DAYS * 86400000 : null,
  })
  for (const st of storages()) {
    try { st.removeItem(KEY) } catch { /* 忽略 */ }
  }
  try {
    ;(remember ? localStorage : sessionStorage).setItem(KEY, value)
  } catch {
    // 存不進去：這次開著的頁面仍維持登入，重新整理後要再登入
  }
  current = { username: acc.username, role: acc.role, label: acc.label }
  emit()
  return { ok: true }
}

export function logout() {
  for (const st of storages()) {
    try { st.removeItem(KEY) } catch { /* 忽略 */ }
  }
  current = null
  emit()
}

export function getSession() {
  return current
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 目前登入的帳號：{ username, role, label }，沒登入是 null */
export function useAuth() {
  return useSyncExternalStore(subscribe, getSession, getSession)
}

export function useIsAdmin() {
  return useAuth()?.role === 'admin'
}
