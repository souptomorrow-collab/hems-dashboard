/**
 * 能源即時流向圖（主頁面）
 * 顯示 PV、家庭負載、電池、電網四個節點與目前功率。
 */
export default function EnergyFlow({ live }) {
  if (!live) return null
  const charging = live.battNetKw > 0.02
  const discharging = live.battNetKw < -0.02
  const reverse = live.gridKw < -0.02

  return (
    <div className="flow">
      {/* 左：太陽能 */}
      <div className="flow-center">
        <div className="flow-node pv">
          <span className="fn-icon">☀️</span>
          <span className="fn-label">太陽能 PV</span>
          <span className="fn-value" style={{ color: 'var(--c-solar)' }}>
            {live.pvKw.toFixed(2)} kW
          </span>
        </div>
      </div>

      {/* 中：家庭負載 */}
      <div className="flow-center">
        <div className="flow-node home">
          <span className="fn-icon">🏠</span>
          <span className="fn-label">家庭負載</span>
          <span className="fn-value" style={{ color: 'var(--c-load)' }}>
            {live.loadKw.toFixed(2)} kW
          </span>
          <span className="dim" style={{ fontSize: 11 }}>
            即時總用電
          </span>
        </div>
      </div>

      {/* 右：電池 + 電網 */}
      <div className="flow-side">
        <div className="flow-node batt">
          <span className="fn-icon">🔋</span>
          <span className="fn-label">
            電池 {charging ? '· 充電中' : discharging ? '· 放電中' : '· 待機'}
          </span>
          <span className="fn-value" style={{ color: 'var(--c-battery)' }}>
            {live.socPct.toFixed(0)}%
          </span>
          <span className="dim" style={{ fontSize: 11 }}>
            {charging && `↑ 充電 ${live.chargeKw.toFixed(2)} kW`}
            {discharging && `↓ 放電 ${live.dischargeKw.toFixed(2)} kW`}
            {!charging && !discharging && `${live.socKwh.toFixed(1)} kWh`}
          </span>
        </div>

        <div className="flow-node grid">
          <span className="fn-icon">🗼</span>
          <span className="fn-label">電網 {reverse ? '· 逆送' : '· 購電'}</span>
          <span className="fn-value" style={{ color: 'var(--c-grid)' }}>
            {Math.abs(live.gridKw).toFixed(2)} kW
          </span>
          <span className="dim" style={{ fontSize: 11 }}>
            {live.tier === 'peak' ? '尖峰' : '離峰'}・{live.price} 元/度
          </span>
        </div>
      </div>
    </div>
  )
}
