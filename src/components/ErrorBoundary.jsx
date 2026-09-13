import { Component } from 'react'

/**
 * 頁面層的錯誤防護。
 *
 * React 在畫面繪製時只要有一個元件丟出例外，預設會把整棵元件樹卸載，整個網站變成一片空白，
 * 連側欄導覽都不見（實測：預測快照裡 target_date 變成物件，就會發生）。
 * 包在 <Outlet> 外面之後，出錯的只有那一頁顯示錯誤說明，側欄、頂端列、其他頁照常可用。
 * Layout 以 pathname 當 key，換頁時會重新建立，錯誤狀態不會帶到下一頁。
 */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[HEMS] 頁面繪製時發生錯誤：', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <section className="panel error-panel" role="alert">
        <h3>這一頁暫時無法顯示</h3>
        <p className="hint prose">
          {'可能是資料檔的格式有問題，或程式遇到沒預料到的狀況。其他頁面仍可正常使用，也可以重新整理再試一次。'}
        </p>
        <details>
          <summary>錯誤訊息</summary>
          <pre>{String(error?.message ?? error)}</pre>
        </details>
        <button className="btn" onClick={() => window.location.reload()}>重新整理</button>
      </section>
    )
  }
}
