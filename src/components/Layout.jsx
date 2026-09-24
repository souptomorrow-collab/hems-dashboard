import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useClock, useCurrentSlot } from '../hooks/useClock.js'
import { PLAN_CUTOFF_SLOT } from '../lib/deviceJobs.js'
import { fmtClock, fmtDate } from '../lib/format.js'
import { getCurrentTier, isSummer, TIER_LABEL } from '../lib/tou.js'
import { LOCATION } from '../lib/time.js'
import { useTheme, toggleTheme } from '../lib/theme.js'
import DemoBar from './DemoBar.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { useScenario, useScenarioDays, setSeason, SEASONS, DEFAULT_SEASON } from '../lib/scenario.js'
import { getDemo, stopDemo, useDemoEnabled } from '../lib/demoClock.js'
import { useAuth, logout } from '../lib/auth.js'
import { pingDemo } from '../api/prefs.js'
import {
  cached, refreshCached, fetchSchedules, fetchOperation, fetchWatcherStatus, SCHEDULES_REFRESHED, DATA_REFRESHED,
} from '../api/forecastData.js'

/** 每一天是用哪一版設定算的；和上次比有變，就是本機又寫回了新的日子 */
const stampsOf = (s, o) => [s, o]
  .map((x) => Object.entries(x?.byDate ?? {}).map(([d, v]) => `${d}:${v.prefs_stamp ?? ''}`).join())
  .join('|')

// admin：只有管理員看得到的頁面
const NAV = [
  { to: '/', label: '主頁面', icon: '🏠', end: true },
  { to: '/planning', label: '用電規劃', icon: '📅', end: false },
  { to: '/history', label: '歷史紀錄', icon: '🗂️', end: false },
  { to: '/system', label: '系統資訊', icon: '⚙️', end: false, admin: true },
]

// 展示模式的控制列：每一頁都放同一條完整的（重播、時間、第幾格、進度條、倍速），切頁不會少資訊。
// 用電規劃的 23:45 截止跟時刻有關，也要看得到現在幾點；系統資訊頁的頁首時鐘照展示時間在走，也要停得下來。
// 鍵盤快捷鍵只在主頁面：歷史紀錄的 ← → 是前後一天，兩個會打架
const DEMO_PAGES = new Set(['/', '/planning', '/history', '/system'])
const DEMO_KEY_PAGES = new Set(['/'])
// 夏月／非夏月（展示 7 月還是 1 月）只在展示模式切換，平常一律 7 月
const SEASON_PAGES = new Set(['/', '/planning', '/history'])

// 側欄收合狀態記在瀏覽器裡，重新整理或下次開啟都維持上次的樣子。
// 無痕視窗或封鎖網站資料時讀寫會直接丟例外，當成沒存過即可。
const SIDEBAR_KEY = 'hems-sidebar-collapsed'
function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

const PAGE_META = {
  '/': { title: '主頁面' },
  '/planning': { title: '用電規劃' },
  '/history': { title: '歷史紀錄' },
  '/system': { title: '系統資訊' },
}

/** 網址 → 查表用的頁面路徑：React Router 比對路由不分大小寫、也接受結尾斜線
    （#/Planning、#/planning/ 都會進到用電規劃），這裡查表也要一樣，否則標題、展示控制列會對不上 */
const pageOf = (pathname) => pathname.toLowerCase().replace(/\/+$/, '') || '/'

export default function Layout() {
  const now = useClock()
  const pathname = pageOf(useLocation().pathname)
  const meta = PAGE_META[pathname] ?? PAGE_META['/']
  const session = useAuth()
  const admin = session?.role === 'admin'
  const nav = NAV.filter((n) => !n.admin || admin)
  const { season } = useScenario()
  const demoOn = useDemoEnabled()
  // 情境切換與展示模式是給管理員展示用的；住戶一律看今天實際的季節
  const scenarioPage = admin && SEASON_PAGES.has(pathname)
  // 夏月／非夏月切換只在展示模式出現（選要播 7 月還是 1 月）；平常就是今天實際的季節
  const seasonToggle = scenarioPage && demoOn
  // 情境頁的電價徽章跟著情境走（非夏月情境下，九月的今天也照非夏月的尖離峰顯示）
  const tier = getCurrentTier(now) // 時鐘的日期就是展示月的今天（平常模式也是）
  const summer = isSummer(now)
  const theme = useTheme()
  const [collapsed, setCollapsed] = useState(readCollapsed)

  // 網頁開著就每分鐘告訴本機的待命程式「有人在用」，它就會叫起、留著排程監看（在哪台電腦開網頁都一樣）。
  // 平常模式和展示模式看的是同一份資料：住戶在用電規劃按「重排」也要有人重算，所以網頁開著就一直通知。
  // 一併告訴它現在的隔日、隔日的規劃截止了沒（換天、到 23:45 就馬上送）：截止時它照最後一份設定排定隔日
  const { next: nextDay } = useScenarioDays()
  const cutoff = useCurrentSlot() >= PLAN_CUTOFF_SLOT
  useEffect(() => {
    pingDemo(nextDay, cutoff)
    const id = setInterval(() => pingDemo(nextDay, cutoff), 60000)
    return () => clearInterval(id)
  }, [nextDay, cutoff])

  // 使用者改了隔日設定，本機從隔日起逐日重算，算完一天就寫回資料庫一天。
  // 各頁（主頁面、用電規劃、歷史紀錄）都靠這裡：本機在重算時每 10 秒重讀
  // 排程與實時運轉，有新寫回的日子就通知各頁重抓——算好的日子馬上看得到，不必等整個月算完或重新整理
  useEffect(() => {
    let on = true
    let wasComputing = false
    const tick = async () => {
      const w = await fetchWatcherStatus().catch(() => null)
      const computing = Boolean(w?.running && w.state === 'computing')
      if (!computing && !wasComputing) return
      wasComputing = computing // 剛算完那次再讀一次，最後一天也接得到
      const [s0, o0] = await Promise.all([
        cached('schedule', fetchSchedules).catch(() => null),
        cached('operation', fetchOperation).catch(() => null),
      ])
      const [s, o] = await Promise.all([
        refreshCached('schedule', fetchSchedules).catch(() => null),
        refreshCached('operation', fetchOperation).catch(() => null),
      ])
      if (!on || !s || !o || stampsOf(s, o) === stampsOf(s0, o0)) return
      window.dispatchEvent(new CustomEvent(SCHEDULES_REFRESHED, { detail: s }))
      window.dispatchEvent(new CustomEvent(DATA_REFRESHED))
    }
    tick()
    const id = setInterval(tick, 10000)
    return () => { on = false; clearInterval(id) }
  }, [])

  // 關掉展示模式就回到夏月（平常一律看 7 月，沒有切換鈕，不能停在 1 月）
  useEffect(() => {
    if (!demoOn && season !== DEFAULT_SEASON) setSeason(DEFAULT_SEASON)
  }, [demoOn, season])

  // 住戶登入時（或管理員登出後換住戶登入），把管理員開著的展示模式關掉（季節由上面回到夏月）
  useEffect(() => {
    if (!admin && getDemo().enabled) stopDemo()
  }, [admin])

  // 頂端列的實際高度寫成 CSS 變數 --topbar-h，展示控制列才知道要黏在哪個高度。
  // 高度不固定：手機上頂端列會折成好幾行，側欄收合也可能讓標題換行
  const topbarRef = useRef(null)
  useEffect(() => {
    const el = topbarRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height)
      document.documentElement.style.setProperty('--topbar-h', `${h}px`)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 瀏覽器分頁標題跟著頁面換，同時開好幾個分頁時才分得出來
  useEffect(() => {
    document.title = `${meta.title}｜家庭能源管理系統`
  }, [meta.title])

  // 換頁時回到頂端：React Router 不會自己重設捲動位置，
  // 手機上從主頁面底部點分頁列切到其他頁，原本會停在新頁面的中間甚至底部
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
    } catch {
      // 存不進去只是下次不記得，不影響功能
    }
  }, [collapsed])

  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      {/* 用按鈕而不是 <a href="#main">：網站用 HashRouter，# 後面是路由，連結會被當成換頁 */}
      <button className="skip-link" onClick={() => document.getElementById('main-content')?.focus()}>
        跳到主要內容
      </button>
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">⚡</div>
          <div className="brand-text">
            <strong>HEMS</strong>
            <span>家庭能源管理系統</span>
          </div>
        </div>

        <nav className="nav">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="icon">{n.icon}</span>
              <span className="nav-label">{n.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar" ref={topbarRef}>
          <div className="topbar-left">
            {/* 側欄的開關只有這一顆：放在頂端列，側欄整個收起來時它也還在 */}
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? '展開側欄' : '收合側欄'}
              aria-label={collapsed ? '展開側欄' : '收合側欄'}
              aria-expanded={!collapsed}
            >
              ☰
            </button>
            {/* 手機上側欄收掉了，品牌 logo 移到頂端列 */}
            <div className="topbar-logo" aria-hidden="true">⚡</div>
            <div className="page-title">
              <h2>{meta.title}</h2>
            </div>
          </div>

          <div className="topbar-right">
            <span className="badge loc" title={`情境地點・${LOCATION.utc}`}>
              📍 {LOCATION.label}
            </span>
            {seasonToggle ? (
              <div className="seg season-seg" role="group" aria-label="展示哪個月（電價季節）">
                {SEASONS.map((s) => (
                  <button
                    key={s.key}
                    className={season === s.key ? `active ${s.key}` : ''}
                    aria-pressed={season === s.key}
                    title={s.hint}
                    onClick={() => setSeason(s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : (
              <span className={`badge ${summer ? 'summer' : ''}`} title="依日期判斷夏月／非夏月">
                {summer ? '夏月' : '非夏月'}
              </span>
            )}
            <span className={`badge ${tier.tier}`}>
              <span className="dot" />
              {TIER_LABEL[tier.tier]}・{tier.price} 元/度
            </span>
            <button
              className="theme-toggle"
              onClick={toggleTheme}
              title={theme === 'dark' ? '切換為日間模式' : '切換為夜間模式'}
              aria-label={theme === 'dark' ? '切換為日間模式' : '切換為夜間模式'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <div className="user-chip" title={`已登入：${session?.username}`}>
              <span className={`badge role-${session?.role}`}>{session?.label}</span>
              <button className="logout-btn" onClick={logout}>登出</button>
            </div>
            <div className="clock">
              <div className="time">{fmtClock(now)}</div>
              <div className="date">{fmtDate(now)}</div>
            </div>
          </div>
        </header>

        <main className="content" id="main-content" tabIndex={-1}>
          {/* 展示模式是全站共用的虛擬時鐘，所以控制列放在版面層而不是單一頁面，每一頁都是同一條完整的 */}
          {admin && DEMO_PAGES.has(pathname) && (
            <DemoBar keys={DEMO_KEY_PAGES.has(pathname)} startPaused={pathname === '/planning'} />
          )}
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* 手機底部分頁列：側欄在手機上藏起來，每個頁面一直都點得到（管理員多一頁系統資訊） */}
      <nav className="tabbar" aria-label="頁面導覽" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}
          >
            <span className="icon">{n.icon}</span>
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
