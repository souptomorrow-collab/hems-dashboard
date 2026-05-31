/** KPI 統計卡：圖示、標題、數值、單位、副標 */
export default function StatCard({ icon, label, value, unit, sub, color }) {
  return (
    <div className="stat-card" style={{ '--accent-color': color }}>
      <div className="sc-top">
        <span>{label}</span>
        <span className="sc-icon">{icon}</span>
      </div>
      <div className="sc-value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="sc-sub">{sub}</div>}
    </div>
  )
}
