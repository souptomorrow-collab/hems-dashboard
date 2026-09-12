import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import { fetchLive, fetchToday } from '../api/client.js'
import { DEVICES, DEVICE_COLORS, CATEGORY_LABEL, COLORS } from '../lib/constants.js'
import { useTheme } from '../lib/theme.js'
import { useDemoClock, slotToDate } from '../lib/demoClock.js'
import { useClock, useCurrentSlot } from '../hooks/useClock.js'
import { slotToTime } from '../lib/constants.js'
import {
  slotXAxis,
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  AXIS_TEXT,
  SPLIT_LINE,
  PANEL_BG,
} from '../lib/charts.js'

const STATUS_LABEL = { on: '運轉中', off: '關閉', standby: '待機' }

export default function Loads() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const demo = useDemoClock()
  const now = useClock()
  const curSlot = useCurrentSlot()
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null)

  useEffect(() => {
    let on = true
    // 展示模式時改由「播到第幾格」驅動，和頁面一的節奏一致
    const at = demo.enabled ? slotToDate(demo.slot) : undefined
    const tick = () => fetchLive(at, curSlot).then((d) => on && setLive(d))
    tick()
    if (demo.enabled) return () => { on = false }
    const id = setInterval(tick, 4000)
    return () => {
      on = false
      clearInterval(id)
    }
  }, [demo.enabled, demo.slot, curSlot])

  // 整日各設備用電：和頁面一一樣吃滾動預測，每前進一格重算一次
  useEffect(() => {
    fetchToday(now, curSlot).then(setToday)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled])

  const devices = live?.devices ?? []
  const shiftable = devices.filter((d) => d.category === 'shiftable')
  const fixed = devices.filter((d) => d.category === 'fixed')
  const sumW = (arr) => arr.reduce((a, d) => a + d.watt, 0)
  const onCount = devices.filter((d) => d.status === 'on').length

  // 各設備即時功率（橫向長條，由大到小）
  const barOption = useMemo(() => {
    const sorted = [...devices].sort((a, b) => a.watt - b.watt)
    return {
      tooltip: { ...baseTooltip, trigger: 'item', valueFormatter: (v) => `${v} W` },
      grid: { left: 84, right: 30, top: 10, bottom: 20 },
      xAxis: { type: 'value', axisLabel: { color: AXIS_TEXT, fontSize: 11 }, splitLine: { lineStyle: { color: SPLIT_LINE } } },
      yAxis: {
        type: 'category',
        data: sorted.map((d) => d.name),
        axisLabel: { color: AXIS_TEXT, fontSize: 12 },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map((d) => ({
            value: d.watt,
            itemStyle: { color: DEVICE_COLORS[d.id], borderRadius: [0, 4, 4, 0] },
          })),
          barWidth: '60%',
          label: { show: true, position: 'right', color: AXIS_TEXT, fontSize: 11, formatter: '{c} W' },
        },
      ],
    }
  }, [devices, theme])

  // 即時用電佔比（甜甜圈）
  const pieOption = useMemo(() => {
    const data = devices
      .filter((d) => d.watt > 0)
      .map((d) => ({ name: d.name, value: d.watt, itemStyle: { color: DEVICE_COLORS[d.id] } }))
    return {
      tooltip: { ...baseTooltip, trigger: 'item', formatter: '{b}: {c} W ({d}%)' },
      legend: { ...baseLegend, type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: AXIS_TEXT, fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          center: ['38%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: PANEL_BG, borderWidth: 2 },
          label: { show: false },
          data,
        },
      ],
    }
  }, [devices, theme])

  // 今日各設備用電堆疊（24h，15 分鐘）
  const stackOption = useMemo(() => {
    if (!today) return {}
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(2)} kW` },
      color: DEVICES.map((d) => DEVICE_COLORS[d.id]),
      legend: { ...baseLegend, type: 'scroll', data: DEVICES.map((d) => d.name) },
      grid: { ...baseGrid, top: 50 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW'),
      series: DEVICES.map((dev) => ({
        name: dev.name,
        type: 'line',
        stack: 'load',
        smooth: false,
        symbol: 'none',
        lineStyle: { width: 0 },
        areaStyle: { color: DEVICE_COLORS[dev.id], opacity: 0.85 },
        emphasis: { focus: 'series' },
        data: today.devicePower[dev.id],
      })),
    }
  }, [today, theme])

  return (
    <>
      <div className="grid kpi cols-4">
        <StatCard icon="🏠" color={COLORS.load} label="即時總負載" value={live ? (sumW(devices) / 1000).toFixed(2) : '—'} unit="kW" sub={`${devices.length} 項設備`} />
        <StatCard icon="🟢" color={COLORS.battery} label="運轉中設備" value={live ? onCount : '—'} unit="項" sub={`待機 ${devices.filter((d) => d.status === 'standby').length} 項`} />
        <StatCard icon="🔄" color={COLORS.grid} label="可轉移負載" value={live ? (sumW(shiftable) / 1000).toFixed(2) : '—'} unit="kW" sub="洗衣/烘衣/洗碗機" />
        <StatCard icon="📌" color="#a855f7" label="不可轉移負載" value={live ? (sumW(fixed) / 1000).toFixed(2) : '—'} unit="kW" sub="冰箱/冷氣/熱水器 等" />
      </div>

      <div className="grid cols-2 mt-16">
        <Panel
          title="各設備即時功率"
          sub={demo.enabled ? `展示模式・${slotToTime(demo.slot)}` : '每 4 秒更新'}
        >
          <EChart option={barOption} height={320} />
        </Panel>
        <Panel title="即時用電佔比">
          <EChart option={pieOption} height={320} />
        </Panel>
      </div>

      <Panel title="設備即時狀態" sub="可轉移 vs 不可轉移" className="mt-16">
        <div className="tag-row" style={{ marginBottom: 14 }}>
          <span className="badge shiftable">● 可轉移 Shiftable</span>
          <span className="badge fixed">● 不可轉移 Non-shiftable</span>
        </div>
        <div className="device-grid">
          {devices.map((d) => {
            const pct = Math.min(100, (d.watt / d.ratedW) * 100)
            return (
              <div className="device-card" key={d.id}>
                <div className="dc-top">
                  <span className="dc-icon">{d.icon}</span>
                  <div>
                    <div className="dc-name">{d.name}</div>
                    <div className="dc-cat">
                      {CATEGORY_LABEL[d.category]}・額定 {d.ratedW} W
                    </div>
                  </div>
                  <span className={`status-pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
                </div>
                <div className="dc-power">
                  {d.watt}
                  <span className="unit"> W</span>
                </div>
                <div className="dc-bar">
                  <span style={{ width: `${pct}%`, background: DEVICE_COLORS[d.id] }} />
                </div>
              </div>
            )
          })}
          {devices.length === 0 &&
            DEVICES.map((d) => <div className="skeleton" key={d.id} style={{ height: 118 }} />)}
        </div>
      </Panel>

      <Panel title="今日各設備用電堆疊" sub="24 小時・15 分鐘為單位（堆疊面積 = 家中總負載）" className="mt-16">
        <EChart option={stackOption} height={340} />
      </Panel>
    </>
  )
}
