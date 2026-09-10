/* ============================================================
   日間／夜間主題

   顏色本身全部定義在 index.css：夜間掛在 :root，日間掛在
   :root[data-theme="light"]。這支只負責三件事——
     1. 決定目前是哪個主題（使用者選過的 > 系統偏好 > 夜間）
     2. 把 data-theme 寫到 <html> 上，讓 CSS 變數整組換掉
     3. 通知 ECharts：圖表的顏色不吃 CSS 變數，得另外換

   為什麼不用 React Context：主題要在 React 掛載之前就套用，
   否則會先閃一下夜間色再跳成日間。這裡在模組載入時就直接套，
   元件端再用 useSyncExternalStore 訂閱後續變化。
   ============================================================ */
import { useSyncExternalStore } from 'react'
import { applyChartTheme } from './charts.js'

const KEY = 'hems-theme'
const listeners = new Set()

function stored() {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    // 無痕視窗或封鎖 cookie 時讀取會直接丟例外，當成沒選過即可
  }
  return null
}

function systemPref() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

let current = stored() ?? systemPref()

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  applyChartTheme(theme)
}

apply(current) // 在第一次 render 之前就套好，避免閃色

// 使用者沒有自己選過時，跟著系統設定走
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (stored()) return
    setTheme(e.matches ? 'light' : 'dark', { remember: false })
  })
} catch {
  // 舊瀏覽器沒有 addEventListener，跟隨系統這件事就略過
}

export function getTheme() {
  return current
}

export function setTheme(theme, { remember = true } = {}) {
  if (theme !== 'dark' && theme !== 'light') return
  current = theme
  apply(theme)
  if (remember) {
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      // 存不進去就只在這次瀏覽有效，不影響功能
    }
  }
  listeners.forEach((fn) => fn())
}

export function toggleTheme() {
  setTheme(current === 'dark' ? 'light' : 'dark')
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 元件端取用目前主題。
 * 圖表的 option 是用 useMemo 算的，把回傳值放進相依陣列，
 * 主題一換就會重算並帶上新的座標軸顏色（元件狀態不會被重置）。
 */
export function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}
