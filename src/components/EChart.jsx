import { useRef, useEffect } from 'react'
import * as echarts from 'echarts'

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
