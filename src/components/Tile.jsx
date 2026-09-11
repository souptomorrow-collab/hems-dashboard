/** 小型數字卡：標題 + 數值 + 單位（+ 附註）。頁面三與歷史紀錄頁共用。 */
export default function Tile({ label, value, unit, sub, color }) {
  return (
    <div className="panel" style={{ padding: '12px 14px', background: 'var(--bg-panel-2)' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          marginTop: 4,
          color: color || 'var(--text)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginLeft: 3 }}>
          {unit}
        </span>
      </div>
      {sub && <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
