import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useClock } from '../hooks/useClock.js'
import { fmtClock, fmtDate } from '../lib/format.js'
import { getCurrentTier, isSummer, TIER_LABEL } from '../lib/tou.js'
import { LOCATION, nowTaipei } from '../lib/time.js'
import { useTheme, toggleTheme } from '../lib/theme.js'
import DemoBar from './DemoBar.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { useScenario, setSeason, SEASONS, scenarioNow, seasonOf, nextDayOf, todayOf } from '../lib/scenario.js'
import { getDemo, stopDemo, useDemoEnabled } from '../lib/demoClock.js'
import { useAuth, logout } from '../lib/auth.js'

// admin：只有管理員看得到的頁面
const NAV = [
  { to: '/', label: '主頁面', icon: '🏠', end: true },
  { to: '/loads', label: '各負載功率', icon: '🔌', end: false },
  { to: '/planning', label: '用電規劃', icon: '📅', end: false },
  { to: '/history', label: '歷史紀錄', icon: '🗂️', end: false },
  { to: '/system', label: '系統資訊', icon: '⚙️', end: false, admin: true },
]

// 展示模式：主頁面、各負載有加速播放；用電規劃只有開關（隔日規劃不看今天播到哪），開了顯示整月
const DEMO_PAGES = new Set(['/', '/loads', '/planning'])
// 夏月／非夏月情境只影響「今天／明天」這幾頁；歷史紀錄照每一天的實際日期
const SEASON_PAGES = new Set(['/', '/loads', '/planning'])

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
  '/': { title: '主頁面', sub: '太陽能・電池・負載・電網 即時總覽' },
  '/loads': { title: '各負載即時功率', sub: '家中各設備即時消耗與分布' },
  '/planning': { title: '用電規劃', sub: '隔日 24 小時最佳化排程（以 15 分鐘為單位）' },
  '/history': { title: '歷史紀錄', sub: '依日／週／月查詢用電、發電、購電與電費，並匯出日報／月報' },
  '/system': { title: '系統資訊', sub: '帳號權限、資料快照、電池與設備規則、電價（管理員）' },
}

export default function Layout() {
  const now = useClock()
  const { pathname } = useLocation()
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
  const tier = getCurrentTier(scenarioPage ? scenarioNow(now, season) : now)
  const summer = isSummer(now)
  // 展示的情境和今天實際的季節不同時（例如九月切到非夏月），頁首下方說明一下，免得看的人搞混
  const shown = SEASONS.find((s) => s.key === season)
  const natural = SEASONS.find((s) => s.key === seasonOf(now))
  const offSeason = seasonToggle && shown && natural && shown.key !== natural.key
  const theme = useTheme()
  const [collapsed, setCollapsed] = useState(readCollapsed)

  // 關掉展示模式就回到今天實際的季節（平常沒有切換鈕，不能停在另一季）
  useEffect(() => {
    if (demoOn) return
    const real = seasonOf(nowTaipei())
    if (season !== real) setSeason(real)
  }, [demoOn, season])

  // 住戶登入時（或管理員登出後換住戶登入），把管理員切過的情境、開著的展示模式恢復原狀
  useEffect(() => {
    if (admin) return
    if (season !== seasonOf(now)) setSeason(seasonOf(now))
    if (getDemo().enabled) stopDemo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, season])

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

        <div className="sidebar-foot">
          基於發電量與負載預測之
          <br />
          家庭能源管理系統
        </div>
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
              <p>{meta.sub}</p>
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
          {/* 展示模式是全站共用的虛擬時鐘，所以控制列放在版面層而不是單一頁面：
              原本只放在主頁面，切到頁面二時展示仍在背景播，卻沒地方暫停或拖曳。
              頁面三是隔日規劃，不受今天的播放進度影響，那一頁就不顯示。 */}
          {offSeason && (
            <div className="scenario-note" role="note">
              <span>
                {getDemo().enabled
                  ? `🔁 目前展示${shown.label}情境：負載、太陽能與天氣換成資料集 ${
                      pathname === '/planning' ? `${nextDayOf(shown.key) ?? '（月底沒有隔日）'}（隔日）` : todayOf(shown.key)}，`
                    + `電價照${shown.label}的尖離峰時段計算。`
                  : `🔁 目前是${shown.label}情境：電價照${shown.label}的尖離峰時段計算，負載與太陽能是模擬的；畫面上的日期與時鐘仍是今天。`}
              </span>
              <button className="scenario-back" onClick={() => setSeason(natural.key)}>
                回到{natural.label}
              </button>
            </div>
          )}
          {admin && DEMO_PAGES.has(pathname) && <DemoBar monthOnly={pathname === '/planning'} />}
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
