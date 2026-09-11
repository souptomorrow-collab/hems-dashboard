/* ============================================================
   匯出：CSV 下載 與 列印成 PDF
   ============================================================ */

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
 * 圖表是 canvas，列印時會照目前畫面輸出；為了在白紙上看得清楚，
 * 夜間模式下會先暫時切到日間再列印，印完切回來。
 */
export function printReport(beforePrint, afterPrint) {
  beforePrint?.()
  // 等主題切換後圖表重畫完再叫出列印視窗
  setTimeout(() => {
    window.print()
    afterPrint?.()
  }, 450)
}
