import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useClock } from '../hooks/useClock.js'
import { fmtClock, fmtDate } from '../lib/format.js'
import { getCurrentTier, isSummer, TIER_LABEL } from '../lib/tou.js'
import { LOCATION } from '../lib/time.js'
import { useTheme, toggleTheme } from '../lib/theme.js'

const NAV = [
  { to: '/', label: '主頁面', icon: '🏠', end: true },
  { to: '/loads', label: '各負載功率', icon: '🔌', end: false },
  { to: '/planning', label: '用電規劃', icon: '📅', end: false },
]

const PAGE_META = {
  '/': { title: '主頁面', sub: '太陽能・電池・負載・電網 即時總覽' },
  '/loads': { title: '各負載即時功率', sub: '家中各設備即時消耗與分布' },
  '/planning': { title: '用電規劃', sub: '隔日 24 小時最佳化排程（以 15 分鐘為單位）' },
}

export default function Layout() {
  const now = useClock()
  const { pathname } = useLocation()
  const meta = PAGE_META[pathname] ?? PAGE_META['/']
  const tier = getCurrentTier(now)
  const summer = isSummer(now)
  const theme = useTheme()

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">⚡</div>
          <div className="brand-text">
            <strong>HEMS</strong>
            <span>家庭能源管理系統</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="icon">{n.icon}</span>
              <span>{n.label}</span>
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
        <header className="topbar">
          <div className="page-title">
            <h2>{meta.title}</h2>
            <p>{meta.sub}</p>
          </div>

          <div className="topbar-right">
            <span className="badge" title={`情境地點・${LOCATION.utc}`}>
              📍 {LOCATION.label}
            </span>
            <span className={`badge ${summer ? 'summer' : ''}`}>
              {summer ? '夏月' : '非夏月'}
            </span>
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
            <div className="clock">
              <div className="time">{fmtClock(now)}</div>
              <div className="date">{fmtDate(now)}</div>
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
