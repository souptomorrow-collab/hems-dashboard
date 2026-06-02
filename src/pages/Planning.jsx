import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import { fetchPlanning, runOptimization, recomputeSchedule } from '../api/client.js'
import { DEVICES, COLORS, CATEGORY_LABEL, slotToTime, slotToHour } from '../lib/constants.js'
import { tomorrow, fmtDate, pad2 } from '../lib/format.js'
import {
  slotXAxis,
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  peakMarkArea,
  AXIS_TEXT,
} from '../lib/charts.js'

const MODES = [
  { key: 'cost', label: '省錢模式', desc: '把可轉移設備與電池充電排到最便宜的時段，電費最低' },
  { key: 'self', label: '自用率最大', desc: '盡量把用電與充電排在白天，最大化太陽能自用' },
  { key: 'peak', label: '舒緩夜尖峰', desc: '避開尖峰用電、尖峰時段以電池供電，降低電網負擔' },
]
const HOURS = Array.from({ length: 24 }, (_, h) => h)

export default function Planning() {
  const [mode, setMode] = useState('cost')
  const [plan, setPlan] = useState(null)
  const [schedule, setSchedule] = useState(null)
  const [computing, setComputing] = useState(false)
  const planDate = useMemo(() => tomorrow(), [])

  // 切換模式 → 取得該模式的最佳化排程
  useEffect(() => {
    let on = true
    setComputing(true)
    fetchPlanning(mode).then((p) => {
      if (!on) return
      setPlan(p)
      setSchedule(p.schedule)
      setComputing(false)
    })
    return () => { on = false }
  }, [mode])

  // 重新計算（重跑演算法，捨棄手動調整）
  const recompute = () => {
    setComputing(true)
    runOptimization(mode).then((p) => {
      setPlan(p)
      setSchedule(p.schedule)
      setComputing(false)
    })
  }

  // 手動切換可轉移設備的某時段 → 即時重算電池調度與成本
  const toggleCell = (devId, slot) => {
    const dev = DEVICES.find((d) => d.id === devId)
    if (dev.category !== 'shiftable' || !schedule) return
    const next = {
      ...schedule,
      [devId]: schedule[devId].map((v, i) => (i === slot ? !v : v)),
    }
    setSchedule(next)
    recomputeSchedule(next, mode).then(setPlan)
  }

  // ---- 電力供需與電池調度 ----
  const supplyOption = useMemo(() => {
    if (!plan) return {}
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(2)}` },
      color: ['#ffb020', '#f97316', '#3b82f6', '#e8edf7', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能供電', '電池放電', '電網供電', '負載預測', 'SOC'] },
      grid: { ...baseGrid, right: 48 },
      xAxis: slotXAxis(),
      yAxis: [
        valueYAxis('kW'),
        { type: 'value', name: 'SOC %', min: 0, max: 100, position: 'right',
          nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
          axisLine: { show: false }, splitLine: { show: false } },
      ],
      series: [
        { name: '太陽能供電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(255,176,32,0.7)' }, data: plan.pvToLoad,
          markArea: peakMarkArea(plan.tier) },
        { name: '電池放電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(249,115,22,0.7)' }, data: plan.battToLoad },
        { name: '電網供電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(59,130,246,0.6)' }, data: plan.gridToLoad },
        { name: '負載預測', type: 'line', symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: '#e8edf7', type: 'dashed' }, data: plan.load },
        { name: 'SOC', type: 'line', yAxisIndex: 1, symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: COLORS.battery }, data: plan.socPct },
      ],
    }
  }, [plan])

  // ---- 電池充放電 + SOC ----
  const battOption = useMemo(() => {
    if (!plan) return {}
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(2)} kW` },
      color: ['rgba(34,197,94,0.8)', 'rgba(20,184,166,0.8)', 'rgba(249,115,22,0.85)', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能充電', '電網充電', '電池放電', 'SOC'] },
      grid: { ...baseGrid, right: 48 },
      xAxis: slotXAxis(),
      yAxis: [
        valueYAxis('kW'),
        { type: 'value', name: 'SOC %', min: 0, max: 100, position: 'right',
          nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
          axisLine: { show: false }, splitLine: { show: false } },
      ],
      series: [
        { name: '太陽能充電', type: 'bar', stack: 'b', data: plan.pvToBatt,
          itemStyle: { color: 'rgba(34,197,94,0.8)' } },
        { name: '電網充電', type: 'bar', stack: 'b', data: plan.gridToBatt,
          itemStyle: { color: 'rgba(20,184,166,0.8)' } },
        { name: '電池放電', type: 'bar', stack: 'b', data: plan.dischargeKw.map((v) => -v),
          itemStyle: { color: 'rgba(249,115,22,0.85)' } },
        { name: 'SOC', type: 'line', yAxisIndex: 1, symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: COLORS.battery }, data: plan.socPct,
          markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(255,255,255,0.2)', type: 'dashed' },
            data: [{ yAxis: 90 }, { yAxis: 10 }] } },
      ],
    }
  }, [plan])

  const s = plan?.summary

  return (
    <>
      {/* 控制列 */}
      <Panel>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, justifyContent: 'space-between' }}>
          <div>
            <div className="mode-tabs">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  className={`mode-tab ${mode === m.key ? 'active' : ''}`}
                  onClick={() => setMode(m.key)}
                  disabled={computing}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              {MODES.find((m) => m.key === mode).desc}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="muted" style={{ fontSize: 12 }}>規劃日（隔日）</div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{fmtDate(planDate)}</div>
            <button className="btn primary" onClick={recompute} disabled={computing}>
              {computing ? <span className="spinner" /> : '⟳'} 重新計算最佳化
            </button>
          </div>
        </div>
      </Panel>

      {/* 結果摘要 */}
      <div className="grid mt-16" style={{ gridTemplateColumns: 'repeat(6,1fr)' }}>
        <Tile label="預估電費" value={s ? s.optimizedCost : '—'} unit="元" />
        <Tile label="預估省電費" value={s ? s.savings : '—'} unit="元" color={COLORS.save} sub={s ? `省 ${s.savingPct}%` : ''} />
        <Tile label="太陽能自用率" value={s ? s.selfUseRate : '—'} unit="%" color={COLORS.solar} />
        <Tile label="向電網購電" value={s ? s.gridImportKwh : '—'} unit="度" color={COLORS.grid} />
        <Tile label="太陽能充電" value={s ? s.pvToBattKwh : '—'} unit="度" color={COLORS.battery} />
        <Tile label="電池放電量" value={s ? s.dischargeKwh : '—'} unit="度" color={COLORS.discharge} />
      </div>

      {/* 供需調度 */}
      <Panel title="電力供需與電池調度" sub="隔日 24 小時・各供電來源堆疊（紅底為尖峰時段）" className="mt-16">
        <EChart option={supplyOption} height={330} />
      </Panel>

      {/* 電池充放電 */}
      <Panel title="電池充放電規劃" sub="太陽能充電 / 電網充電 / 放電 與 SOC（虛線為 10%–90% 上下限）" className="mt-16">
        <EChart option={battOption} height={300} />
      </Panel>

      {/* 設備運行時段甘特 */}
      <Panel
        title="各設備運行時段"
        sub="隔日 24 小時・15 分鐘為單位"
        right={
          <span className="hint">✏️ 可轉移設備可點擊格子手動調整，電池與成本會即時重算</span>
        }
        className="mt-16"
      >
        {schedule && plan ? (
          <>
            <div className="gantt">
              <table>
                <thead>
                  <tr>
                    <th className="dev-name" style={{ textAlign: 'left' }}>設備</th>
                    {HOURS.map((h) => (
                      <th key={h} colSpan={4}>{pad2(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DEVICES.map((dev) => (
                    <tr key={dev.id}>
                      <td className="dev-name">
                        <span style={{ marginRight: 6 }}>{dev.icon}</span>
                        {dev.name}
                        <span className={`badge ${dev.category === 'shiftable' ? 'shiftable' : 'fixed'}`}
                          style={{ marginLeft: 8, fontSize: 10, padding: '1px 7px' }}>
                          {CATEGORY_LABEL[dev.category]}
                        </span>
                      </td>
                      {schedule[dev.id].map((on, slot) => {
                        const peak = plan.tier[slot] === 'peak'
                        const editable = dev.category === 'shiftable'
                        const cls = ['cell']
                        if (peak) cls.push('peak-bg')
                        if (on) cls.push('on', dev.category === 'shiftable' ? 'shiftable' : 'fixed')
                        if (editable) cls.push('editable')
                        return (
                          <td
                            key={slot}
                            className={cls.join(' ')}
                            title={`${dev.name}｜${slotToTime(slot)}｜${peak ? '尖峰' : '離峰'}${editable ? '（可點擊調整）' : ''}`}
                            onClick={() => toggleCell(dev.id, slot)}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="legend mt-16">
              <span className="item"><span className="swatch" style={{ background: '#3b82f6' }} /> 可轉移設備運轉</span>
              <span className="item"><span className="swatch" style={{ background: '#a855f7' }} /> 不可轉移設備運轉</span>
              <span className="item"><span className="swatch" style={{ background: 'rgba(239,68,68,0.18)' }} /> 尖峰時段</span>
            </div>
          </>
        ) : (
          <div className="skeleton" style={{ height: 360 }} />
        )}
      </Panel>
    </>
  )
}

function Tile({ label, value, unit, sub, color }) {
  return (
    <div className="panel" style={{ padding: '12px 14px', background: 'var(--bg-panel-2)' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginLeft: 3 }}>{unit}</span>
      </div>
      {sub && <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
