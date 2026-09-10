import { useEffect, useState } from 'react'

/**
 * 能源即時流向圖（主頁面）
 *
 * 以「家庭用電」為中央匯流排，畫出三條動態流向：
 *   太陽能 → 家、電池 ↔ 家、電網 ↔ 家
 * 線條的方向、粗細、是否流動都由即時功率決定（能量平衡）：
 *   PV + 電池放電 + 電網購電 = 家庭負載 + 電池充電 + 電網逆送
 */

/* 各節點在容器中的百分比座標（與 SVG viewBox 0~100 對齊）
 *
 * 寬版：左側 太陽能/電網（兩個來源）→ 中央 家（匯流排）→ 右側 電池
 * 窄版（手機）：兩個來源並排在上 → 家在中 → 電池在下，改走垂直流向。
 *   手機寬度下卡片佔容器的比例大很多（106px / 約 320px ≈ 33%），
 *   沿用寬版座標會讓三張卡片直接疊在一起。
 *
 * r 為節點的「半徑」（百分比，x/y 分開給）：容器不是正方形且兩種
 * 版面的長寬比差很多，連線內縮量必須依方向取橢圓半徑才會貼齊卡片邊緣。
 */
const N_WIDE = {
  pv: { key: 'pv', x: 14, y: 27, r: { x: 10, y: 19 } },
  grid: { key: 'grid', x: 14, y: 73, r: { x: 10, y: 19 } },
  home: { key: 'home', x: 48, y: 50, r: { x: 11, y: 21 } },
  batt: { key: 'batt', x: 86, y: 50, r: { x: 10, y: 19 } },
}
const N_NARROW = {
  pv: { key: 'pv', x: 25, y: 14, r: { x: 19, y: 14 } },
  grid: { key: 'grid', x: 75, y: 14, r: { x: 19, y: 14 } },
  home: { key: 'home', x: 50, y: 52, r: { x: 21, y: 16 } },
  batt: { key: 'batt', x: 50, y: 88, r: { x: 19, y: 14 } },
}

// 把兩節點之間的連線往內縮（避免線壓到卡片）。
// 同時回傳「標籤錨點」(lx,ly)：在線的中點往垂直方向上方推開，避免數值蓋住流動線。
// 橢圓在 (ux,uy) 方向上的半徑
const radiusAt = (r, ux, uy) => 1 / Math.hypot(ux / r.x, uy / r.y)

function trimmed(a, b, K = 8, mode = 'up') {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const ta = radiusAt(a.r, ux, uy)
  const tb = radiusAt(b.r, ux, uy)
  const sx = a.x + ux * ta
  const sy = a.y + uy * ta
  const ex = b.x - ux * tb
  const ey = b.y - uy * tb
  const mx = (sx + ex) / 2
  const my = (sy + ey) / 2
  /* 法向量：把標籤推離連線本身。
     'up'  寬版——一律往上推。
     'out' 窄版——水平分量改為「遠離容器中線」。窄版的兩條來源線
           （太陽能→家、電網→家）是左右對稱地匯聚到中央，若也一律
           往上推，兩個標籤會朝彼此靠攏而重疊。 */
  let px = -uy
  let py = ux
  if (mode === 'out') {
    // 窄版：斜線（來源→家）的中點本來就落在空白處，不必再推；
    // 垂直線（家→電池）的中點兩側都是卡片，必須推到卡片外緣才看得到。
    if (Math.abs(uy) > 0.9) {
      px = Math.sign(mx - 50 || 1) * 2.2
      py = 0
    } else {
      px = 0
      py = 0
    }
  } else if (py > 0) {
    px = -px
    py = -py
  }
  return { d: `M${sx} ${sy}L${ex} ${ey}`, mx, my, lx: mx + px * K, ly: my + py * K }
}

// 功率（kW）→ 線寬（px），以 5 kW 為滿格
const lineWidth = (p) => 2 + 3.5 * Math.min(1, p / 5)

const railsOf = (N) => [
  [N.pv, N.home],
  [N.grid, N.home],
  [N.batt, N.home],
]

/** 視窗寬度是否進入窄版（與 index.css 的斷點一致） */
function useNarrowLayout(query = '(max-width: 760px)') {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (e) => setNarrow(e.matches)
    setNarrow(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return narrow
}

export default function EnergyFlow({ live }) {
  const narrow = useNarrowLayout()
  const N = narrow ? N_NARROW : N_WIDE
  const RAILS = railsOf(N)
  const labelK = narrow ? 11 : 8 // 流量標籤離線的距離
  const labelMode = narrow ? 'out' : 'up'
  const pv = live?.pvKw ?? 0
  const load = live?.loadKw ?? 0
  const charge = live?.chargeKw ?? 0
  const discharge = live?.dischargeKw ?? 0
  const gridKw = live?.gridKw ?? 0
  const imp = Math.max(0, gridKw)
  const exp = Math.max(0, -gridKw)

  const charging = charge > 0.02
  const discharging = discharge > 0.02
  const reverse = exp > 0.02

  // 三條邊（依方向決定 from→to 與顏色）
  const edges = [
    { from: N.pv, to: N.home, p: pv, color: '#ffb020' },
    charging
      ? { from: N.home, to: N.batt, p: charge, color: '#22c55e' }
      : { from: N.batt, to: N.home, p: discharge, color: '#f97316' },
    reverse
      ? { from: N.home, to: N.grid, p: exp, color: '#14b8a6' }
      : { from: N.grid, to: N.home, p: imp, color: '#3b82f6' },
  ]

  const flows = edges
    .filter((e) => e.p > 0.02)
    .map((e) => ({ ...e, geo: trimmed(e.from, e.to, labelK, labelMode) }))

  return (
    <div className={`flow ${live ? '' : 'flow-empty'}`}>
      {/* 流向線 */}
      <svg className="flow-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {RAILS.map(([a, b], i) => (
          <path key={`rail-${i}`} className="flow-rail" d={trimmed(a, b, labelK, labelMode).d} />
        ))}
        {flows.map((e, i) => (
          <path
            key={`flow-${i}`}
            className="flow-line"
            d={e.geo.d}
            style={{ stroke: e.color, color: e.color, strokeWidth: lineWidth(e.p) }}
          />
        ))}
      </svg>

      {/* 流量數值（推到線的上方，避免蓋住流動線） */}
      {flows.map((e, i) => (
        <span
          key={`val-${i}`}
          className="flow-edge-val"
          style={{ left: `${e.geo.lx}%`, top: `${e.geo.ly}%`, color: e.color }}
        >
          {e.p.toFixed(2)} kW
        </span>
      ))}

      {/* 節點 */}
      <FlowNode
        n={N.pv}
        variant="pv"
        icon="☀️"
        label="太陽能 PV"
        color="var(--c-solar)"
        value={live ? `${pv.toFixed(2)} kW` : '—'}
        sub="即時發電"
      />
      <FlowNode
        n={N.home}
        variant="home"
        icon="🏠"
        label="家庭用電"
        color="var(--c-load)"
        value={live ? `${load.toFixed(2)} kW` : '—'}
        sub="即時總負載"
      />
      <FlowNode
        n={N.batt}
        variant="batt"
        icon="🔋"
        label={`電池${charging ? ' · 充電中' : discharging ? ' · 放電中' : ' · 待機'}`}
        color="var(--c-battery)"
        value={live ? `${live.socPct.toFixed(0)}%` : '—'}
        sub={
          live
            ? charging
              ? `↑ 充電 ${charge.toFixed(2)} kW`
              : discharging
              ? `↓ 放電 ${discharge.toFixed(2)} kW`
              : `${live.socKwh.toFixed(1)} kWh`
            : ''
        }
      />
      <FlowNode
        n={N.grid}
        variant="grid"
        icon="🗼"
        label={`電網${reverse ? ' · 逆送' : ' · 購電'}`}
        color="var(--c-grid)"
        value={live ? `${Math.abs(gridKw).toFixed(2)} kW` : '—'}
        sub={live ? `${live.tier === 'peak' ? '尖峰' : '離峰'}・${live.price} 元/度` : ''}
      />
    </div>
  )
}

function FlowNode({ n, variant, icon, label, color, value, sub }) {
  return (
    <div className={`flow-node ${variant}`} style={{ left: `${n.x}%`, top: `${n.y}%` }}>
      <span className="fn-icon">{icon}</span>
      <span className="fn-label">{label}</span>
      <span className="fn-value" style={{ color }}>
        {value}
      </span>
      {sub && <span className="fn-sub">{sub}</span>}
    </div>
  )
}
