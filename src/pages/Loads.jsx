import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import { fetchLive, fetchToday } from '../api/client.js'
import { DEVICES, DEVICE_COLORS, DEVICE_GROUPS, CATEGORY_LABEL, COLORS, SLOTS_PER_DAY, slotToTime } from '../lib/constants.js'
import { useTheme } from '../lib/theme.js'
import { useDemoClock, slotToDate } from '../lib/demoClock.js'
import { useScenario } from '../lib/scenario.js'
import { useClock, useCurrentSlot } from '../hooks/useClock.js'
import { useMediaQuery } from '../hooks/useMediaQuery.js'
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
const GROUP_BY_ID = Object.fromEntries(DEVICE_GROUPS.map((g) => [g.id, g]))
const deviceName = (id) => DEVICES.find((d) => d.id === id)?.name ?? id
/** 分組裡有哪些設備（只有一台的分組不必另外列） */
const membersText = (g) => (g.members.length > 1 ? g.members.map(deviceName).join('、') : '')

export default function Loads() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const demo = useDemoClock()
  const now = useClock()
  const curSlot = useCurrentSlot()
  const { season } = useScenario()
  const narrow = useMediaQuery('(max-width: 760px)') // 手機上圓餅圖的圖例改放下方
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
  }, [demo.enabled, demo.slot, curSlot, season])

  // 整日各設備用電：和頁面一一樣吃滾動預測，每前進一格重算一次
  useEffect(() => {
    let on = true
    fetchToday(now, curSlot).then((d) => on && setToday(d))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled, season])

  const devices = live?.devices ?? []
  const shiftable = devices.filter((d) => d.category === 'shiftable')
  const fixed = devices.filter((d) => d.category === 'fixed')
  const sumW = (arr) => arr.reduce((a, d) => a + d.watt, 0)
  const onCount = devices.filter((d) => d.status === 'on').length

  // 各設備即時功率（橫向長條，由大到小）；顏色跟著圖表分組，和下面兩張圖一致
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

  // 即時用電佔比（甜甜圈）：依圖表分組加總，小功率的四台併成「其他家電」
  const pieOption = useMemo(() => {
    const data = DEVICE_GROUPS.map((g) => ({
      id: g.id,
      name: g.name,
      value: devices.filter((d) => g.members.includes(d.id)).reduce((a, d) => a + d.watt, 0),
      itemStyle: { color: DEVICE_COLORS[g.id] },
    })).filter((x) => x.value > 0)
    return {
      tooltip: {
        ...baseTooltip,
        trigger: 'item',
        formatter: (p) => {
          const g = GROUP_BY_ID[p.data.id]
          const parts = g && g.members.length > 1
            ? devices.filter((d) => g.members.includes(d.id) && d.watt > 0).map((d) => `${d.name} ${d.watt} W`).join('、')
            : ''
          return `${p.marker}${p.name}：${p.value} W（${p.percent}%）${parts ? `<br/>${parts}` : ''}`
        },
      },
      // 手機寬度下圖例放右邊會把圓餅擠得很小、上下又留一大片空白，改成放在下方
      legend: narrow
        ? { ...baseLegend, type: 'scroll', top: 'auto', bottom: 0, textStyle: { color: AXIS_TEXT, fontSize: 11 } }
        : { ...baseLegend, type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: AXIS_TEXT, fontSize: 11 } },
      series: [
        {
          type: 'pie',
          radius: narrow ? ['42%', '70%'] : ['45%', '72%'],
          center: narrow ? ['50%', '45%'] : ['38%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: PANEL_BG, borderWidth: 2 },
          label: { show: false },
          data,
        },
      ],
    }
  }, [devices, theme, narrow])

  // 今日各設備用電堆疊：依圖表分組加總（最多 8 組），由下往上先可轉移、再不可轉移
  const stackGroups = useMemo(() => {
    if (!today) return []
    return DEVICE_GROUPS.map((g) => {
      const data = new Array(SLOTS_PER_DAY).fill(0)
      for (const m of g.members) {
        today.devicePower[m]?.forEach((v, i) => { data[i] += v })
      }
      return { ...g, data: data.map((v) => +v.toFixed(3)) }
    }).filter((g) => g.data.some((v) => v > 0))
  }, [today])

  const stackOption = useMemo(() => {
    if (!stackGroups.length) return {}
    return {
      tooltip: {
        ...baseTooltip,
        // 依分類分段列出，各段附小計，才看得出這一刻可轉移、不可轉移各用了多少
        formatter: (ps) => {
          const sum = (list) => list.reduce((a, p) => a + (+p.value || 0), 0)
          const block = (cat) => {
            const list = ps.filter((p) => GROUP_BY_ID[p.seriesId]?.category === cat && +p.value > 0.0005)
            if (!list.length) return ''
            return `<b>${CATEGORY_LABEL[cat]}　${sum(list).toFixed(2)} kW</b><br/>` +
              list.map((p) => `${p.marker}${p.seriesName}　${(+p.value).toFixed(2)} kW`).join('<br/>') + '<br/>'
          }
          return `${ps[0].axisValueLabel}<br/>${block('shiftable')}${block('fixed')}<b>合計　${sum(ps).toFixed(2)} kW</b>`
        },
      },
      // 圖例改用上方的 HTML 分組圖例（ECharts 的圖例沒辦法分組，手機上還得翻頁）
      legend: { show: false },
      grid: { ...baseGrid, top: 30 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW'),
      series: stackGroups.map((g) => ({
        id: g.id,
        name: g.name,
        type: 'line',
        stack: 'load',
        smooth: false,
        symbol: 'none',
        // 每一層上緣畫一條底色細線，相鄰色塊之間留出縫隙，才分得出層與層
        lineStyle: { width: 1, color: PANEL_BG },
        // itemStyle 決定提示框裡的色點；只設 areaStyle 的話色點會用 ECharts 預設色盤，和圖上的顏色對不起來
        itemStyle: { color: DEVICE_COLORS[g.id] },
        areaStyle: { color: DEVICE_COLORS[g.id], opacity: 0.92 },
        // 不做「滑到哪一層就淡化其他層」：手機上手指一碰整張圖就變淡，反而看不清楚
        emphasis: { disabled: true },
        data: g.data,
      })),
    }
  }, [stackGroups, theme])

  return (
    <>
      <div className="grid kpi cols-4">
        <StatCard icon="🏠" color={COLORS.load} label="即時總負載" value={live ? (sumW(devices) / 1000).toFixed(2) : '—'} unit="kW" sub={`${devices.filter((d) => d.ratedW).length} 項設備`} />
        <StatCard icon="🟢" color={COLORS.battery} label="運轉中設備" value={live ? onCount : '—'} unit="項" sub={`待機 ${devices.filter((d) => d.status === 'standby').length} 項`} />
        <StatCard icon="🔄" color={COLORS.grid} label="可轉移負載" value={live ? (sumW(shiftable) / 1000).toFixed(2) : '—'} unit="kW" sub="洗衣/烘衣/洗碗機" />
        <StatCard icon="📌" color="#a855f7" label="不可轉移負載" value={live ? (sumW(fixed) / 1000).toFixed(2) : '—'} unit="kW" sub="冰箱/冷氣/照明 等" />
      </div>

      <div className="grid cols-2 mt-16">
        <Panel
          title="各設備即時功率"
          sub={demo.enabled ? `展示模式・${slotToTime(demo.slot)}` : '每 4 秒更新'}
        >
          <EChart option={barOption} height={320} label="各設備即時功率長條圖" />
        </Panel>
        <Panel title="即時用電佔比" sub="電腦、電視、微波爐、監控設備併為「其他家電」">
          <EChart option={pieOption} height={narrow ? 270 : 320} label="即時用電佔比圓餅圖" />
        </Panel>
      </div>

      <Panel title="設備即時狀態" sub="可轉移 vs 不可轉移" className="mt-16">
        <div className="tag-row" style={{ marginBottom: 14 }}>
          <span className="badge shiftable">● 可轉移 Shiftable</span>
          <span className="badge fixed">● 不可轉移 Non-shiftable</span>
        </div>
        <div className="device-grid">
          {devices.map((d) => {
            // 未分項沒有額定功率，進度條改看它佔即時總負載的比例
            const pct = Math.min(100, (d.watt / (d.ratedW ?? Math.max(1, sumW(devices)))) * 100)
            return (
              <div className="device-card" key={d.id}>
                <div className="dc-top">
                  <span className="dc-icon">{d.icon}</span>
                  <div>
                    <div className="dc-name">{d.name}</div>
                    <div className="dc-cat">
                      {d.ratedW ? (
                        <>
                          {CATEGORY_LABEL[d.category]}・<span className="dc-rated-word">額定 </span>{d.ratedW}&nbsp;W
                        </>
                      ) : '其他無法歸類的用電'}
                    </div>
                  </div>
                </div>
                <div className="dc-power-row">
                  <div className="dc-power">
                    {d.watt}
                    <span className="unit"> W</span>
                  </div>
                  <span className={`status-pill ${d.status}`}>{STATUS_LABEL[d.status]}</span>
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

      <Panel
        title="今日各設備用電堆疊"
        sub="24 小時・15 分鐘為單位・堆疊高度 = 家中總負載；由下往上先是可轉移、再是不可轉移設備，灰色「未分項」是預測總量中無法歸到特定設備的用電"
        className="mt-16"
      >
        {stackGroups.length > 0 && (
          <div className="group-legend">
            {['shiftable', 'fixed'].map((cat) => (
              <div key={cat} className="gl-group">
                <span className={`badge ${cat}`}>{CATEGORY_LABEL[cat]}</span>
                {stackGroups.filter((g) => g.category === cat).map((g) => (
                  <span key={g.id} className="gl-item">
                    <i style={{ background: DEVICE_COLORS[g.id] }} />
                    {g.name}
                    {membersText(g) && <span className="dim">（{membersText(g)}）</span>}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
        <EChart option={stackOption} height={320} label="今日各設備用電堆疊面積圖" />
      </Panel>
    </>
  )
}
