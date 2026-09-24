/* ============================================================
   匯出：CSV 下載 與 列印成 PDF
   ============================================================ */
import { getInstanceByDom } from 'echarts/core'

/**
 * 物件陣列 → CSV 字串。
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string,digits?:number}>} cols  欄位順序、表頭文字、小數位
 */
export function toCsv(rows, cols) {
  const esc = (v) => {
    if (v == null) return ''
    const s = String(v)
    // 值裡有逗號、引號或換行才需要包引號；引號本身要重複一次
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const fmt = (v, digits) =>
    typeof v === 'number' && Number.isFinite(v) && digits != null ? v.toFixed(digits) : v
  const head = cols.map((c) => esc(c.label)).join(',')
  const body = rows.map((r) => cols.map((c) => esc(fmt(r[c.key], c.digits))).join(','))
  return [head, ...body].join('\r\n')
}

/**
 * 觸發瀏覽器下載一個 CSV 檔。
 * 開頭加 BOM：Excel 看到 BOM 才會用 UTF-8 開啟，否則中文表頭會變亂碼。
 */
export function downloadCsv(filename, csv) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延後釋放：部分瀏覽器在 click 後才開始讀取 blob，太早 revoke 會下載失敗
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 列印／另存 PDF。
 * 版面由 index.css 的 @media print 處理（隱藏側欄、頂端列與按鈕，只留報表本體）。
 * 圖表是 canvas，要照紙張寬度重畫才不會被裁掉，見下面的 fitChartsOnPrint（頁面掛載時要先呼叫）。
 * 為了在白紙上看得清楚，夜間模式下會先暫時切到日間再列印，印完切回來。
 */
export function printReport(beforePrint, afterPrint) {
  beforePrint?.()
  // 等主題切換後圖表重畫完再叫出列印視窗
  setTimeout(() => {
    window.print()
    afterPrint?.()
  }, 450)
}

/** 列印版面裡圖表最寬大約幾 px：A4 直式扣掉 12mm 邊界（index.css 的 @page）約 703px，再扣面板內距。
    只在瀏覽器沒有在列印排版時通知 matchMedia('print') 的情況下備用，取小一點，寧可右邊留白也不要被裁 */
const PRINT_CHART_W = 660

/**
 * 列印時圖表照紙張寬度重畫，印完照螢幕寬度畫回來；回傳取消監聽的函式（給 useEffect 用）。
 *
 * 圖表是 canvas，寬度是螢幕上量到的像素。紙張比螢幕窄，不重畫的話全寬的圖只印得到左半邊
 * （當日運轉曲線大約到 10:00～11:00），圖例也被切掉。EChart.jsx 靠 ResizeObserver 跟著容器縮放，
 * 但列印排版不會觸發它，所以在這裡自己 resize：
 *   - beforeprint：版面還是螢幕的，先縮到紙張一定放得下的寬度（只送這個事件的瀏覽器至少不會被裁）
 *   - matchMedia('print') 變成符合：這時已經是列印排版（Chrome、Edge 產生預覽前會通知），
 *     照容器實際寬度重畫，剛好填滿紙寬
 *   - afterprint、離開列印：照螢幕上的容器寬度畫回來
 * 要寫 width: 'auto' 才會回到「量容器寬度」；只寫 resize() 會沿用上一次指定的寬度。
 * 列印期間瀏覽器不會跑下一個畫面，resize 之後要 flush，canvas 才會立刻畫上新的版面。
 * @param {ParentNode} [root]  在哪個範圍找圖表（預設整頁）
 */
export function fitChartsOnPrint(root = document) {
  const each = (fn) => {
    for (const el of root.querySelectorAll('.chart')) {
      const chart = getInstanceByDom(el)
      if (!chart || chart.isDisposed()) continue
      fn(chart, el)
      chart.getZr().flush()
    }
  }
  const shrink = () => each((chart, el) => el.clientWidth > PRINT_CHART_W && chart.resize({ width: PRINT_CHART_W }))
  const fit = () => each((chart) => chart.resize({ width: 'auto' }))
  const media = window.matchMedia?.('print')
  window.addEventListener('beforeprint', shrink)
  window.addEventListener('afterprint', fit)
  media?.addEventListener?.('change', fit)
  return () => {
    window.removeEventListener('beforeprint', shrink)
    window.removeEventListener('afterprint', fit)
    media?.removeEventListener?.('change', fit)
  }
}
