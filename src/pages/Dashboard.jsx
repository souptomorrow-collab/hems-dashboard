import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import EnergyFlow from '../components/EnergyFlow.jsx'
import { fetchLive, fetchToday, fetchPlanning } from '../api/client.js'
import { COLORS, BATTERY } from '../lib/constants.js'
import {
  slotXAxis,
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  peakMarkArea,
} from '../lib/charts.js'

export default function Dashboard() {
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null)
  const [plan, setPlan] = useState(null)

  // 即時快照：每 5 秒更新一次
  useEffect(() => {
    let on = true
    const tick = () => fetchLive().then((d) => on && setLive(d))
    tick()
    const id = setInterval(tick, 5000)
    return () => {
      on = false
      clearInterval(id)
    }
  }, [])

  // 今日整日 + 隔日預測：載入一次
  useEffect(() => {
    fetchToday().then(setToday)
    fetchPlanning('cost').then(setPlan)
  }, [])

  // ---- 主圖：今日功率總覽 ----
  const overviewOption = useMemo(() => {
    if (!today) return {}
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(2)} kW` },
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電'] },
      grid: baseGrid,
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW'),
      series: [
        {
          name: '太陽能發電',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: today.pv,
          lineStyle: { width: 2, color: COLORS.solar },
          areaStyle: { color: 'rgba(255,176,32,0.18)' },
          markArea: peakMarkArea(today.tier),
        },
        {
          name: '家庭負載',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: today.load,
          lineStyle: { width: 2, color: COLORS.load },
        },
        {
          name: '電網購電',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: today.gridKw,
          lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' },
        },
        {
          name: '電池充電',
          type: 'bar',
          stack: 'batt',
          data: today.chargeKw,
          itemStyle: { color: 'rgba(34,197,94,0.55)' },
        },
        {
          name: '電池放電',
          type: 'bar',
          stack: 'batt',
          data: today.dischargeKw.map((v) => -v),
          itemStyle: { color: 'rgba(249,115,22,0.6)' },
        },
      ],
    }
  }, [today])

  // ---- 電池 SOC 儀表 ----
  const gaugeOption = useMemo(() => {
    const soc = live?.socPct ?? 0
    return {
      series: [
        {
          type: 'gauge',
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: 100,
          radius: '92%',
          progress: { show: true, width: 14, itemStyle: { color: COLORS.battery } },
          axisLine: { lineStyle: { width: 14, color: [[1, 'rgba(255,255,255,0.08)']] } },
          axisTick: { show: false },
          splitLine: { length: 10, lineStyle: { color: 'rgba(255,255,255,0.15)' } },
          axisLabel: { color: '#6b7693', fontSize: 10, distance: 14 },
          pointer: { width: 4, itemStyle: { color: COLORS.battery } },
          anchor: { show: true, size: 10, itemStyle: { color: COLORS.battery } },
          detail: {
            valueAnimation: true,
            formatter: '{value}%',
            color: '#e8edf7',
            fontSize: 26,
            fontWeight: 'bolder',
            offsetCenter: [0, '55%'],
          },
          data: [{ value: soc }],
        },
      ],
    }
  }, [live])

  // ---- 隔日預測：太陽能發電 + 家庭負載 + 淨負載（鴨子曲線）----
  const forecastOption = useMemo(() => {
    if (!plan) return {}
    const netLoad = plan.load.map((v, i) => +(v - plan.pv[i]).toFixed(3))
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(2)} kW` },
      legend: { ...baseLegend, data: ['太陽能發電預測', '家庭負載預測', '淨負載'] },
      grid: baseGrid,
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW'),
      series: [
        {
          name: '太陽能發電預測',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: plan.pv,
          lineStyle: { width: 2, color: COLORS.solar },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(255,176,32,0.35)' },
                { offset: 1, color: 'rgba(255,176,32,0.02)' },
              ],
            },
          },
        },
        {
          name: '家庭負載預測',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: plan.load,
          lineStyle: { width: 2, color: COLORS.load },
        },
        {
          name: '淨負載',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: netLoad,
          lineStyle: { width: 1.5, color: '#06b6d4', type: 'dashed' },
        },
      ],
    }
  }, [plan])

  const s = today?.summary
  const ps = plan?.summary

  return (
    <>
      {/* KPI 列 */}
      <div className="grid kpi">
        <StatCard
          icon="☀️"
          color={COLORS.solar}
          label="太陽能即時發電"
          value={live ? live.pvKw.toFixed(2) : '—'}
          unit="kW"
          sub={s ? `今日累積發電 ${s.pvKwh} 度` : ' '}
        />
        <StatCard
          icon="🔋"
          color={COLORS.battery}
          label="電池電量 SOC"
          value={live ? live.socPct.toFixed(0) : '—'}
          unit="%"
          sub={
            live
              ? live.battNetKw > 0.02
                ? `充電中 ${live.chargeKw.toFixed(2)} kW`
                : live.battNetKw < -0.02
                ? `放電中 ${live.dischargeKw.toFixed(2)} kW`
                : `${live.socKwh.toFixed(1)} / ${BATTERY.capacityKwh} 度`
              : ' '
          }
        />
        <StatCard
          icon="🏠"
          color={COLORS.load}
          label="家中總負載"
          value={live ? live.loadKw.toFixed(2) : '—'}
          unit="kW"
          sub={s ? `今日累積用電 ${s.loadKwh} 度` : ' '}
        />
        <StatCard
          icon="🗼"
          color={COLORS.grid}
          label={live && live.gridKw < -0.02 ? '電網逆送' : '電網購電'}
          value={live ? Math.abs(live.gridKw).toFixed(2) : '—'}
          unit="kW"
          sub={live ? `${live.tier === 'peak' ? '尖峰' : '離峰'}・${live.price} 元/度` : ' '}
        />
        <StatCard
          icon="💰"
          color={COLORS.save}
          label="今日省下電費"
          value={s ? s.savings : '—'}
          unit="元"
          sub={s ? `較無儲能節省 ${s.savingPct}%` : ' '}
        />
      </div>

      {/* 流向 + 電池 */}
      <div className="grid cols-2 mt-16">
        <Panel title="能源即時流向" sub="每 5 秒更新">
          <EnergyFlow live={live} />
        </Panel>
        <Panel
          title="電池狀態"
          sub={`Tesla Powerwall 2・${BATTERY.capacityKwh} kWh`}
          right={
            <span className="badge">
              上下限 {BATTERY.socMin * 100}–{BATTERY.socMax * 100}%
            </span>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <EChart option={gaugeOption} height={210} style={{ flex: 1 }} />
            <div style={{ flex: 1, display: 'grid', gap: 12 }}>
              <InfoRow label="即時電量" value={`${live ? live.socKwh.toFixed(1) : '—'} 度`} />
              <InfoRow
                label="充電功率"
                value={`${live ? live.chargeKw.toFixed(2) : '—'} kW`}
                color={COLORS.battery}
              />
              <InfoRow
                label="放電功率"
                value={`${live ? live.dischargeKw.toFixed(2) : '—'} kW`}
                color={COLORS.discharge}
              />
              <InfoRow label="最大功率" value={`${BATTERY.maxPowerKw} kW`} />
            </div>
          </div>
        </Panel>
      </div>

      {/* 今日總覽 */}
      <Panel
        title="今日功率總覽"
        sub="太陽能・負載・電網・電池充放電（紅底為尖峰時段）"
        className="mt-16"
      >
        <EChart option={overviewOption} height={340} />
      </Panel>

      {/* 隔日預測 + 最佳化結果 */}
      <div className="grid cols-2 mt-16">
        <Panel title="隔日預測：發電 vs 負載" sub="太陽能發電 LSTM／家庭負載 RF（隨機森林）預測｜明日（淨負載呈鴨子曲線）">
          <EChart option={forecastOption} height={260} />
        </Panel>
        <Panel title="隔日最佳化結果" sub="GA 排程摘要（省錢模式）">
          {ps ? (
            <div className="grid cols-2" style={{ gap: 12 }}>
              <Metric label="預測發電" value={`${ps.pvKwh} 度`} color={COLORS.solar} />
              <Metric label="預估用電" value={`${ps.loadKwh} 度`} color={COLORS.load} />
              <Metric label="向電網購電" value={`${ps.gridImportKwh} 度`} color={COLORS.grid} />
              <Metric label="太陽能自用率" value={`${ps.selfUseRate}%`} color={COLORS.battery} />
              <Metric label="預估電費" value={`${ps.optimizedCost} 元`} />
              <Metric label="預估省電費" value={`${ps.savings} 元`} color={COLORS.save} />
            </div>
          ) : (
            <div className="skeleton" style={{ height: 160 }} />
          )}
          <p className="hint mt-16">
            💡 詳細排程與手動調整請見「用電規劃」頁面
          </p>
        </Panel>
      </div>
    </>
  )
}

function InfoRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      <strong style={{ fontSize: 16, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </strong>
    </div>
  )
}

function Metric({ label, value, color }) {
  return (
    <div className="panel" style={{ padding: '12px 14px', background: 'var(--bg-panel-2)' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: color || 'var(--text)' }}>
        {value}
      </div>
    </div>
  )
}
