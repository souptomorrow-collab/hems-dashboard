import { useRef, useEffect } from 'react'
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
  LabelLayout,
  CanvasRenderer,
])

/**
 * 輕量 ECharts 包裝元件。
 * - option 改變時自動 setOption
 * - 視窗 / 容器大小改變時自動 resize
 * - 卸載時 dispose 釋放資源
 */
export default function EChart({ option, height = 320, className = '', style }) {
  const elRef = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    const chart = echarts.init(elRef.current, null, { renderer: 'canvas' })
    chartRef.current = chart

    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(elRef.current)

    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    // notMerge = true：確保切換頁面/模式時不殘留舊系列
    chartRef.current?.setOption(option, true)
  }, [option])

  return (
    <div
      ref={elRef}
      className={`chart ${className}`}
      style={{ height, ...style }}
    />
  )
}
