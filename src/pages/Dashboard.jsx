import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import EnergyFlow from '../components/EnergyFlow.jsx'
import WeatherStrip from '../components/WeatherStrip.jsx'
import { fetchLive, fetchToday, fetchPlanning, loadForecastMeta } from '../api/client.js'
import { COLORS, BATTERY } from '../lib/constants.js'
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
  peakMarkArea,
  rainMarkArea,
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK,
  TRACK_LINE,
} from '../lib/charts.js'

export default function Dashboard() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const demo = useDemoClock()
  const now = useClock() // 展示模式開著時，這個已經是虛擬時間
  const curSlot = useCurrentSlot() // 過去／未來的分界，也決定滾動預測取哪一筆

  // kW 軸的範圍「只增不減」。
  // 滾動預測每前進一格就換一次資料，若讓軸自動縮放，播放時整張圖會不停上下跳，
  // 前後時刻也沒辦法比較。記住看過的最大／最小值，軸就只會變寬不會變窄。
  const kwRange = useRef({ min: 0, max: 0 })
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null)
  const [plan, setPlan] = useState(null)
  const [loadMeta, setLoadMeta] = useState(null) // 負載預測的資料來源

  // 即時快照。
  // 真實時間：每 5 秒抓一次。
  // 展示模式：改由「目前播到第幾格」驅動，每前進一格就重算一次，
  //          這樣畫面更新的節奏和進度條、時鐘完全同步。
  useEffect(() => {
    let on = true
    const at = demo.enabled ? slotToDate(demo.slot) : undefined
    const tick = () => fetchLive(at, curSlot).then((d) => on && setLive(d))
    tick()
    if (demo.enabled) return () => { on = false }
    const id = setInterval(tick, 5000)
    return () => {
      on = false
      clearInterval(id)
    }
  }, [demo.enabled, demo.slot, curSlot])

  // 今日整日：每前進一格就重算一次。
  // RF 是滾動預測（每 15 分鐘重發未來 96 步），所以「未來」那段會隨時間更新；
  // 「過去」那段吃的是真實值、不會變，dispatch 又是照時間順序推的，
  // 因此已經發生的電池／電網軌跡自然凍住，不需要另外處理。
  useEffect(() => {
    fetchToday(now, curSlot).then(setToday)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled])

  // 隔日預測 + 最佳化：載入一次（那是明天的事，不隨今天的進度改變）
  useEffect(() => {
    fetchPlanning().then((d) => {
      setPlan(d)
      setLoadMeta(loadForecastMeta())
    })
  }, [])

  // ---- 主圖：今日功率總覽 ----
  /* ------------------------------------------------------------
     即時 vs 預測：拆成兩張圖

     原本只有一張「今日功率總覽」畫滿全天 96 格，但在任一時刻，
     只有「到現在為止」那段是已經發生的，後面都還是預測，混在同一張圖裡
     會讓人分不清哪些是結果、哪些是計畫。

     這裡用同一個 option 產生器做兩張：
       upTo 有值  → 只畫到第 upTo 格（之後補 null），曲線隨時間長出來
       upTo 為 null → 整天都畫，並在展示模式下標出目前播到哪

     x 軸兩張都保持完整的 24 小時，即時那張才不會邊播邊縮放。

     註：目前「即時」那段是把同一條模擬曲線切到現在為止。之後接上真實
     量測後，這裡應改讀量測紀錄，而不是切預測曲線。
     ------------------------------------------------------------ */
  const dayOption = (upTo, showPlayhead) => {
    // 只保留 upTo 之前的點，之後補 null（ECharts 會直接斷線，不會連到 0）
    const clip = (arr) =>
      upTo == null ? arr : arr.map((v, i) => (i <= upTo ? v : null))
    if (!today) return {}

    // kW 軸的範圍一律用「整天」的資料算，兩張圖才會是同一把尺；
    // 否則即時那張會隨著資料長出來一直自動縮放，也沒辦法和下面那張對照。
    const all = [
      ...today.pv, ...today.load, ...today.gridKw,
      ...today.chargeKw, ...today.dischargeKw.map((v) => -v),
    ].filter((v) => Number.isFinite(v))
    kwRange.current = {
      max: Math.max(kwRange.current.max, Math.ceil(Math.max(0, ...all))),
      min: Math.min(kwRange.current.min, Math.floor(Math.min(0, ...all))),
    }
    const { min: kwMin, max: kwMax } = kwRange.current
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .map((p) => {
              const val =
                p.seriesName === 'SOC'
                  ? `${Math.round(p.value)}%`
                  : `${(+p.value).toFixed(2)} kW`
              return `${p.marker}${p.seriesName}: ${val}`
            })
            .join('<br/>'),
      },
      color: [COLORS.solar, COLORS.load, COLORS.grid, 'rgba(34,197,94,0.55)', 'rgba(249,115,22,0.6)', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      grid: { ...baseGrid, right: 48 },
      xAxis: slotXAxis(),
      yAxis: [
        valueYAxis('kW', { min: kwMin, max: kwMax }),
        {
          type: 'value',
          name: 'SOC %',
          min: 0,
          max: 100,
          position: 'right',
          nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
          axisLine: { show: false },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '太陽能發電',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: clip(today.pv),
          lineStyle: { width: 2, color: COLORS.solar },
          areaStyle: { color: 'rgba(255,176,32,0.18)' },
          markArea: peakMarkArea(today.tier),
          // 展示模式下標出「現在播到哪」，一天 96 格的進度一眼可見
          markLine: showPlayhead && demo.enabled
            ? {
                silent: true,
                symbol: 'none',
                label: {
                  formatter: slotToTime(demo.slot),
                  // 垂直的 markLine 標籤預設會跟著線轉成直排，要明確轉回水平
                  rotate: 0,
                  position: 'end',
                  distance: 4,
                  color: TEXT_MAIN,
                  fontSize: 11,
                  fontWeight: 700,
                  backgroundColor: 'rgba(20,184,166,0.16)',
                  borderColor: COLORS.save,
                  borderWidth: 1,
                  borderRadius: 4,
                  padding: [3, 6],
                },
                lineStyle: { color: COLORS.save, width: 1.5, type: 'solid' },
                data: [{ xAxis: demo.slot }],
              }
            : undefined,
        },
        {
          name: '家庭負載',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: clip(today.load),
          lineStyle: { width: 2, color: COLORS.load },
        },
        {
          name: '電網購電',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: clip(today.gridKw),
          lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' },
        },
        {
          name: '電池充電',
          type: 'bar',
          stack: 'batt',
          data: clip(today.chargeKw),
          itemStyle: { color: 'rgba(34,197,94,0.55)' },
        },
        {
          name: '電池放電',
          type: 'bar',
          stack: 'batt',
          data: clip(today.dischargeKw).map((v) => (v == null ? null : -v)),
          itemStyle: { color: 'rgba(249,115,22,0.6)' },
        },
        {
          name: 'SOC',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: clip(today.socPct),
          lineStyle: { width: 2.5, color: COLORS.battery },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
            lineStyle: { color: TRACK_LINE, type: 'dashed' },
            data: [{ yAxis: 90 }, { yAxis: 10 }],
          },
        },
      ],
    }
  }

  const realtimeOption = useMemo(
    () => dayOption(curSlot, false),
    [today, theme, curSlot]
  )
  const dayPlanOption = useMemo(
    () => dayOption(null, true),
    [today, theme, demo.enabled, demo.slot]
  )


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
          axisLine: { lineStyle: { width: 14, color: [[1, TRACK]] } },
          axisTick: { show: false },
          splitLine: { length: 10, lineStyle: { color: TRACK_LINE } },
          axisLabel: { color: AXIS_TEXT, fontSize: 10, distance: 14 },
          pointer: { width: 4, itemStyle: { color: COLORS.battery } },
          anchor: { show: true, size: 10, itemStyle: { color: COLORS.battery } },
          detail: {
            valueAnimation: true,
            formatter: '{value}%',
            color: TEXT_MAIN,
            fontSize: 26,
            fontWeight: 'bolder',
            offsetCenter: [0, '55%'],
          },
          data: [{ value: soc }],
        },
      ],
    }
  }, [live, theme])

  // ---- 隔日預測：太陽能發電 + 家庭負載 + 淨負載（鴨子曲線）----
  const forecastOption = useMemo(() => {
    if (!plan) return {}
    const fixedLoad = plan.fixedLoad ?? plan.load
    const netLoad = fixedLoad.map((v, i) => +(v - plan.pv[i]).toFixed(3))
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(2)} kW` },
      color: [COLORS.solar, COLORS.load, '#06b6d4'],
      legend: { ...baseLegend, data: ['太陽能發電預測', '不可轉移負載預測', '淨負載'] },
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
          markArea: rainMarkArea(plan.weather),
        },
        {
          name: '不可轉移負載預測',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: fixedLoad,
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
  }, [plan, theme])

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
          sub={
            live && live.curtailKw > 0.02
              ? `防逆送削減 ${live.curtailKw.toFixed(2)} kW（可發 ${live.pvPotentialKw.toFixed(2)}）`
              : s
              ? `今日累積發電 ${s.pvKwh} 度`
              : ' '
          }
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
        <Panel
          title="能源即時流向"
          sub={demo.enabled ? `展示模式・${slotToTime(demo.slot)}` : '每 5 秒更新'}
        >
          <EnergyFlow live={live} />
        </Panel>
        <Panel
          title="電池狀態"
          sub={`Tesla Powerwall 2・${BATTERY.capacityKwh} kWh`}
          style={{ display: 'flex', flexDirection: 'column' }}
          right={
            <span className="badge">
              上下限 {BATTERY.socMin * 100}–{BATTERY.socMax * 100}%
            </span>
          }
        >
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
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

      {/* 即時：只畫到目前為止，曲線隨時間長出來 */}
      <Panel
        title="即時運轉"
        sub={`今日 00:00 ～ ${slotToTime(curSlot)}・不可轉移負載取當日真實值（隨時間累積）`}
        className="mt-16"
        right={
          <span className="badge">
            {demo.enabled ? '展示模式' : '真實時間'}・第 {curSlot + 1} / 96 格
          </span>
        }
      >
        <EChart option={realtimeOption} height={300} />
      </Panel>

      {/* 預測與排程：整天都畫，和上面那張刻意分開，避免把「已發生」和「還沒發生」混為一談 */}
      <Panel
        title="今日預測與排程"
        sub={`過去用真實值、未來用 ${slotToTime(curSlot)} 發布的最新一次 RF 預測重新規劃・紅底為尖峰時段`}
        className="mt-16"
      >
        <EChart option={dayPlanOption} height={300} />
      </Panel>

      {/* 隔日預測 + 最佳化結果 */}
      <div className="grid cols-2 mt-16">
        <Panel
          title="隔日預測：發電 vs 負載"
          sub={
            '太陽能 LSTM／不可轉移負載 RF 預測；可轉移負載由排程決定（見用電規劃）' +
            (loadMeta?.datasetDate ? `・負載取自資料集 ${loadMeta.datasetDate}` : '')
          }
          right={
            <div style={{ display: 'flex', gap: 6 }}>
              {plan && (
                <span
                  className="badge"
                  title={
                    plan.loadSource === 'rf'
                      ? `不可轉移負載＝RF 真實預測\n刷新時刻 ${loadMeta?.refresh ?? '—'}\n依一日中的時段對齊到畫面日期`
                      : '雲端連不上，暫時使用模擬負載'
                  }
                >
                  {plan.loadSource === 'rf' ? '🌐 RF 雲端預測' : '🧪 模擬負載'}
                </span>
              )}
              {plan?.weather && (
                <span className="badge" title="天氣資料來源">
                  {plan.weather.source === 'cwa' ? '🌐 CWA 即時天氣' : '🧪 模擬天氣'}
                </span>
              )}
            </div>
          }
        >
          {plan?.weather && (
            <div className="wx-head">
              <span className="wx-big">{plan.weather.summary.icon}</span>
              <div>
                <div className="wx-title">明日天氣：{plan.weather.summary.label}</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  {plan.weather.summary.tempMin}–{plan.weather.summary.tempMax}°C・
                  降雨機率最高 {plan.weather.summary.popMax}%
                </div>
              </div>
            </div>
          )}
          <WeatherStrip weather={plan?.weather} />
          <EChart option={forecastOption} height={260} />
        </Panel>
        <Panel title="隔日最佳化結果" sub="GA 排程摘要（省錢模式）" className="fill-col">
          {ps ? (
            <div className="grid cols-2 grow" style={{ gap: 12 }}>
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
    <div
      className="panel"
      style={{
        padding: '12px 14px',
        background: 'var(--bg-panel-2)',
        // 這張卡片可能被拉高以填滿面板（見 .panel.fill-col），內容置中才不會黏在上緣
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: color || 'var(--text)' }}>
        {value}
      </div>
    </div>
  )
}
