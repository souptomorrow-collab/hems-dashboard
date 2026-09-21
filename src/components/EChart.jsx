import { useRef, useEffect, useState } from 'react'
/* 按需載入：只註冊實際用到的圖表種類與元件。
   直接 import 整包 'echarts' 會把地圖、雷達圖、3D 等用不到的東西全帶進來（約 1 MB）。
   之後新增圖表種類（例如散佈圖）或元件（例如 dataZoom），要記得在這裡補註冊，
   否則那張圖會畫不出來，console 會提示缺少哪個元件。 */
import * as echarts from 'echarts/core'
import { LineChart, BarChart, PieChart, GaugeChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
} from 'echarts/components'
import { LabelLayout } from 'echarts/features' // 座標軸標籤的 hideOverlap 要用
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent, // 整月檢視的縮放（滑鼠滾輪／下方拖曳條）
  LabelLayout,
  CanvasRenderer,
])

/** 圖表寬度低於這個值就當成窄版（手機、或很窄的面板） */
const NARROW_BELOW = 520
/** 圖例從一行變兩行時，繪圖區往下讓出的高度 */
const LEGEND_EXTRA_ROW = 22

/**
 * 窄版時的圖例：原本是單行可翻頁的 scroll 圖例，手機上一頁只放得下三項，
 * SOC、電池充放電要按箭頭翻頁才看得到。項目多於三項時改成可換行的圖例，
 * 第一個繪圖區往下讓一行的高度，圖例才不會壓到 y 軸軸名。
 * 直式圖例、放在下方的圖例、項目少的圖例都維持原樣。
 */
function adaptLegend(option, narrow) {
  const lg = option?.legend
  if (!narrow || !lg || Array.isArray(lg)) return option
  if (lg.show === false || lg.type !== 'scroll' || lg.orient === 'vertical' || lg.bottom != null) return option
  if ((lg.data?.length ?? 0) <= 3) return option
  const bump = (g) => ({ ...g, top: (typeof g.top === 'number' ? g.top : 60) + LEGEND_EXTRA_ROW })
  const grid = Array.isArray(option.grid)
    ? option.grid.map((g, i) => (i === 0 ? bump(g) : g))
    : option.grid && bump(option.grid)
  return { ...option, legend: { ...lg, type: 'plain' }, grid }
}

/** onEvents 支援的事件（要用別的事件再加進來） */
const EVENTS = ['click', 'datazoom']

/**
 * 輕量 ECharts 包裝元件。
 * - option 改變時自動 setOption
 * - 視窗 / 容器大小改變時自動 resize，窄版時調整圖例（見 adaptLegend）
 * - 資料還沒到（option 是空物件）時顯示載入中的底色，不是一塊空白
 * - onEvents：{ click(params, chart), datazoom(params, chart) }，例如點長條就縮放到那一天
 * - 卸載時 dispose 釋放資源
 */
export default function EChart({ option, height = 320, className = '', style, label, onEvents }) {
  const elRef = useRef(null)
  const chartRef = useRef(null)
  const [narrow, setNarrow] = useState(false)
  const handlers = useRef(onEvents)
  handlers.current = onEvents

  useEffect(() => {
    const chart = echarts.init(elRef.current, null, { renderer: 'canvas' })
    chartRef.current = chart
    for (const name of EVENTS) chart.on(name, (p) => handlers.current?.[name]?.(p, chart))

    const ro = new ResizeObserver(([entry]) => {
      chart.resize()
      setNarrow(entry.contentRect.width < NARROW_BELOW)
    })
    ro.observe(elRef.current)

    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    // notMerge = true：確保切換頁面/模式時不殘留舊系列
    chartRef.current?.setOption(adaptLegend(option, narrow), true)
  }, [option, narrow])

  const empty = !option || Object.keys(option).length === 0
  return (
    <div
      ref={elRef}
      className={`chart ${empty ? 'chart-empty' : ''} ${className}`}
      style={{ height, ...style }}
      // 圖表畫在 canvas 上，螢幕報讀器讀不到內容，至少要說出這是哪一張圖
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-busy={empty || undefined}
    />
  )
}
