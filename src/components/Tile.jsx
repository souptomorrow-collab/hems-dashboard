/** 小型數字卡：標題 + 數值 + 單位（+ 附註）。頁面三與歷史紀錄頁共用。
 *
 *  color 只用在標題前的小色塊，數字一律用文字色。
 *  原本數字直接塗成能源色：日間模式淺底上，太陽能橘只有 1.7:1、省電費青綠 2.3:1，數字看不清楚。 */
export default function Tile({ label, value, unit, sub, color }) {
  return (
    <div className="panel tile" style={{ padding: '12px 14px', background: 'var(--bg-panel-2)' }}>
      <div className="muted tile-label">
        {color && <i className="tile-dot" style={{ background: color }} aria-hidden="true" />}
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          marginTop: 4,
          color: 'var(--text)',
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
