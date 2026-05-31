/** 通用卡片面板：標題列 + 內容 */
export default function Panel({ title, sub, right, children, className = '', style }) {
  return (
    <section className={`panel ${className}`} style={style}>
      {(title || right) && (
        <div className="panel-head">
          <div>
            {title && <h3>{title}</h3>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}
