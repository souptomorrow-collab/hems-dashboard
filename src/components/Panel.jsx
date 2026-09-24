/** 通用卡片面板：標題列 + 內容（不放副標小字） */
export default function Panel({ title, right, children, className = '', style }) {
  return (
    <section className={`panel ${className}`} style={style}>
      {(title || right) && (
        <div className="panel-head">
          <div>
            {title && <h3>{title}</h3>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}
