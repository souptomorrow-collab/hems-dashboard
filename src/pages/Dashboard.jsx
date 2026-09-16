import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import EnergyFlow from '../components/EnergyFlow.jsx'
import WeatherStrip from '../components/WeatherStrip.jsx'
import { fetchLive, fetchToday, fetchShowcase } from '../api/client.js'
import { COLORS, BATTERY, SLOT_HOURS, slotToTime } from '../lib/constants.js'
import { useTheme } from '../lib/theme.js'
import { useDemoClock, slotToDate } from '../lib/demoClock.js'
import { useScenario } from '../lib/scenario.js'
import { useClock, useCurrentSlot } from '../hooks/useClock.js'
import { useMediaQuery } from '../hooks/useMediaQuery.js'
import { useIsAdmin } from '../lib/auth.js'
import {
  slotXAxis,
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  peakMarkArea,
  powerSocLayout,
  powerSocFormatter,
  socYAxis,
  SOC_EXTRA_HEIGHT,
  socExtraHeight,
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK,
  TRACK_LINE,
} from '../lib/charts.js'

/** 時間線標籤的對齊：清晨往右長、深夜往左長，才不會壓到左上角的軸名「kW」或超出右邊界 */
function edgeAlign(s) {
  return s < 24 ? 'left' : s > 72 ? 'right' : 'center'
}

/** 「現在」那條垂直線（負載、太陽能「預測與實際」兩張圖共用） */
function nowLine(s) {
  const align = edgeAlign(s)
  return {
    silent: true,
    symbol: 'none',
    label: {
      formatter: `現在 ${slotToTime(s)}`,
      rotate: 0, // 垂直的 markLine 標籤預設會跟著線轉成直排，要明確轉回水平
      position: 'end',
      distance: 4,
      align,
      // 往右長時和線、軸名再隔開一點（00:00 時線剛好在 y 軸上）
      padding: align === 'left' ? [0, 0, 0, 12] : align === 'right' ? [0, 6, 0, 0] : 0,
      color: TEXT_MAIN,
      fontSize: 11,
      fontWeight: 700,
    },
    lineStyle: { color: COLORS.save, width: 1.5, type: 'solid' },
    data: [{ xAxis: s }],
  }
}

const PLAN_SOC_H = 140 // 今日計畫那張的 SOC 小圖高度（SOC 在 15%～90% 之間變化，太矮會看起來是一條平線）

export default function Dashboard() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const demo = useDemoClock()
  const now = useClock() // 展示模式開著時，這個已經是虛擬時間
  const curSlot = useCurrentSlot() // 過去（真實值）／未來（日前預測）的分界
  const { season } = useScenario() // 夏月／非夏月情境，一換就整頁重抓
  const narrow = useMediaQuery('(max-width: 760px)')
  // 住戶看不到預測模型相關的圖與資料來源標示，說明文字也改成一般用語
  const admin = useIsAdmin()

  // 即時運轉那張的 kW 軸「只增不減」，兩個情境各記各的。
  // 每前進一格就多一格真實值、資料跟著換，若讓軸自動縮放，播放時整張圖會不停上下跳。
  // 今日計畫那張整天資料固定，軸直接依自己的資料決定，不和即時那張共用
  // （共用的話，真實負載的尖峰會把計畫那張的軸撐到 8 kW，曲線擠成一團）。
  const kwRange = useRef({})
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null) // 過去真實值＋未來日前預測（即時運轉用）
  const [dayPlan, setDayPlan] = useState(null) // 前一晚排定的全天計畫（今日預測與排程用）
  const [show, setShow] = useState(null) // 展示日的原始陣列（負載與太陽能的日前預測、實際值）

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
  }, [demo.enabled, demo.slot, curSlot, season])

  // 今日整日：每前進一格就重算一次。
  // 「未來」那段用前一晚 23:45 的日前預測（一天一次，和排程相同），不隨時間更新；
  // 「過去」那段吃的是真實值，每前進一格就多一格真實值。dispatch 照時間順序推，
  // 因此已經發生的電池／電網軌跡自然凍住，不需要另外處理。
  useEffect(() => {
    let on = true
    fetchToday(now, curSlot).then((d) => on && setToday(d))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled, season])

  // 今日全天計畫：排程一天只排一次，整天都是同一份（負載、太陽能都用前一晚的日前預測）
  useEffect(() => {
    let on = true
    fetchToday(now).then((d) => on && setDayPlan(d))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo.enabled, season])

  // 展示日原始資料：每個情境載入一次，之後只是依目前格數取不同的列
  useEffect(() => {
    let on = true
    fetchShowcase().then((d) => on && setShow(d))
    return () => { on = false }
  }, [season])

  // ---- 主圖：今日功率總覽 ----
  /* ------------------------------------------------------------
     即時 vs 預測：拆成兩張圖

     在任一時刻，只有「到現在為止」那段是已經發生的，後面都還是預測，
     混在同一張圖裡會讓人分不清哪些是結果、哪些是計畫。

     這裡用同一個 option 產生器做兩張：
       即時運轉      today（過去真實值），只畫到第 upTo 格，曲線隨時間長出來
       今日預測與排程 dayPlan（前一晚排定的全天計畫），整天都畫，展示模式下標出目前播到哪

     x 軸兩張都保持完整的 24 小時，即時那張才不會邊播邊縮放。
     ------------------------------------------------------------ */
  const allKw = (d) => [
    ...d.pv, ...d.load, ...d.gridKw, ...d.chargeKw, ...d.dischargeKw.map((v) => -v),
  ].filter((v) => Number.isFinite(v))

  // 刻度間距挑「不超過 7 格」的最小值，上下限對齊到間距上；
  // 直接拿資料的最大最小值當上下限，軸上會出現 8、6、3、0、-3、-5 這種不等距的刻度
  const niceAxis = (lo, hi, maxTicks = 7) => {
    const step = [0.5, 1, 2, 5, 10].find((st) => (Math.ceil(hi / st) - Math.floor(lo / st)) <= maxTicks) ?? 10
    return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, interval: step }
  }

  // 即時運轉：整天的真實負載都算進去（尖峰時購電可能到負載＋充電），播放時軸才不會中途變寬
  const realtimeAxis = () => {
    const vals = allKw(today)
    if (show?.actual) {
      show.actual.forEach((v, i) => Number.isFinite(v) && vals.push(v + (today.chargeKw[i] ?? 0)))
    }
    const key = today.season ?? 'summer'
    const prev = kwRange.current[key] ?? { min: 0, max: 0 }
    const r = (kwRange.current[key] = {
      max: Math.max(prev.max, Math.max(0, ...vals)),
      min: Math.min(prev.min, Math.min(0, ...vals)),
    })
    return niceAxis(r.min, r.max)
  }

  // 今日計畫：整天資料固定，直接照自己的最大最小值
  const planAxis = () => {
    const vals = allKw(dayPlan)
    // 圖比較高，刻度可以密一點（0.5 kW），曲線的起伏才看得出來
    return niceAxis(Math.min(0, ...vals), Math.max(0, ...vals), 10)
  }

  // detail：今日計畫那張用較高的 SOC 小圖、不做平滑、較寬的電池長條，細節才看得出來
  const dayOption = (d, upTo, showPlayhead, kwAxis, detail = false) => {
    const smooth = !detail
    // 只保留 upTo 之前的點，之後補 null（ECharts 會直接斷線，不會連到 0）
    const clip = (arr) =>
      upTo == null ? arr : arr.map((v, i) => (i <= upTo ? v : null))
    return {
      // 展示模式每秒換一次資料：保留動畫的話，每次更新都會重播一段進場，
      // 播放頭的時間標籤看起來會一直抖。真實時間模式更新慢，動畫留著比較順
      animation: !demo.enabled,
      tooltip: { ...baseTooltip, formatter: powerSocFormatter },
      color: [COLORS.solar, COLORS.load, COLORS.grid, 'rgba(34,197,94,0.55)', 'rgba(249,115,22,0.6)', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      // 功率在上、SOC 在下面一小格，不再共用一張圖的左右兩條 y 軸（見 charts.js 的 powerSocLayout）
      ...powerSocLayout(detail ? { socH: PLAN_SOC_H } : {}),
      yAxis: [valueYAxis('kW', kwAxis), socYAxis(detail ? { interval: 25 } : {})],
      series: [
        {
          name: '太陽能發電',
          type: 'line',
          smooth,
          symbol: 'none',
          data: clip(d.pv),
          lineStyle: { width: 2, color: COLORS.solar },
          areaStyle: { color: 'rgba(255,176,32,0.18)' },
          markArea: peakMarkArea(d.tier),
          // 展示模式下標出「現在播到哪」，一天 96 格的進度一眼可見
          markLine: showPlayhead && demo.enabled
            ? {
                silent: true,
                symbol: 'none',
                label: {
                  formatter: slotToTime(demo.slot),
                  rotate: 0,
                  position: 'end',
                  distance: 4,
                  align: edgeAlign(demo.slot),
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
          smooth,
          symbol: 'none',
          data: clip(d.load),
          lineStyle: { width: 2, color: COLORS.load },
        },
        {
          name: '電網購電',
          type: 'line',
          smooth,
          symbol: 'none',
          data: clip(d.gridKw),
          lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' },
        },
        {
          name: '電池充電',
          type: 'bar',
          stack: 'batt',
          ...(detail ? { barCategoryGap: '8%' } : {}),
          data: clip(d.chargeKw),
          itemStyle: { color: 'rgba(34,197,94,0.55)' },
        },
        {
          name: '電池放電',
          type: 'bar',
          stack: 'batt',
          ...(detail ? { barCategoryGap: '8%' } : {}),
          data: clip(d.dischargeKw).map((v) => (v == null ? null : -v)),
          itemStyle: { color: 'rgba(249,115,22,0.6)' },
        },
        {
          name: 'SOC',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          smooth,
          symbol: 'none',
          data: clip(d.socPct),
          lineStyle: { width: 2.5, color: COLORS.battery },
          markArea: peakMarkArea(d.tier),
          markLine: {
            silent: true,
            symbol: 'none',
            label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
            lineStyle: { color: TRACK_LINE, type: 'dashed' },
            data: [{ yAxis: Math.round(BATTERY.socMax * 100) }, { yAxis: Math.round(BATTERY.socMin * 100) }],
          },
        },
      ],
    }
  }

  const realtimeOption = useMemo(
    () => (today ? dayOption(today, curSlot, false, realtimeAxis()) : {}),
    [today, show, theme, curSlot]
  )
  const dayPlanOption = useMemo(
    () => (dayPlan ? dayOption(dayPlan, null, true, planAxis(), true) : {}),
    [dayPlan, theme, demo.enabled, demo.slot]
  )

  /* ------------------------------------------------------------
     太陽能：LSTM 日前預測 vs 實際

     發電量預測一天只發一次（前一晚 23:45），整天用的都是同一條曲線，
     和負載那張一樣，重點是預測和實際差多少。
     實際值是用 ERA5 實測日射量換算的發電量（不是實測出力），和負載的真實值一樣只畫到現在。
     ------------------------------------------------------------ */
  const pvOption = useMemo(() => {
    if (!show?.pv) return {}
    const s = curSlot
    const actual = show.pvActual?.map((v, i) => (i <= s ? v : null)) ?? null
    const peak = Math.max(0.5, ...show.pv, ...(show.pvActual ?? []).filter((v) => Number.isFinite(v)))
    const line = { type: 'line', smooth: true, symbol: 'none', connectNulls: false }
    return {
      animation: !demo.enabled,
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .filter((p) => p.value != null)
            .map((p) => `${p.marker}${p.seriesName}: ${(+p.value).toFixed(2)} kW`)
            .join('<br/>'),
      },
      legend: { ...baseLegend, data: ['LSTM 日前預測', ...(actual ? ['實際（日射量換算）'] : [])] },
      grid: { ...baseGrid, right: 24 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW', { min: 0, max: Math.ceil(peak) }),
      series: [
        {
          ...line,
          name: 'LSTM 日前預測',
          data: show.pv,
          lineStyle: { width: 2, type: 'dashed', color: COLORS.solar },
          itemStyle: { color: COLORS.solar },
          areaStyle: { color: 'rgba(255,176,32,0.14)' },
          markLine: nowLine(s),
        },
        ...(actual
          ? [{
              ...line,
              name: '實際（日射量換算）',
              data: actual,
              lineStyle: { width: 2, color: TEXT_MAIN },
              itemStyle: { color: TEXT_MAIN },
            }]
          : []),
      ],
    }
  }, [show, curSlot, theme, demo.enabled])

  const pvStats = useMemo(() => {
    if (!show?.pv) return null
    const kwh = (arr, n) =>
      arr.slice(0, n).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0) * SLOT_HOURS
    const n = curSlot + 1
    const fcNow = kwh(show.pv, n)
    const acNow = show.pvActual ? kwh(show.pvActual, n) : null
    return {
      fcAll: kwh(show.pv, 96),
      fcNow,
      acNow,
      // 發電量太少時百分比沒有意義（清晨實際 0.1 度、差 0.05 度就是 50%）
      diffPct: acNow != null && acNow >= 0.5 ? ((fcNow - acNow) / acNow) * 100 : null,
    }
  }, [show, curSlot])

  /* ------------------------------------------------------------
     不可轉移負載：RF 日前預測 vs 實際

     排程一天只排一次，用的是前一晚 23:45 發布的預測，UI 也只顯示那一次
     （RF 其實每 15 分鐘會重發，但目前不拿來重新排程）。
     和太陽能那張一樣，整天是同一條預測曲線，實際值只畫到現在。
     ------------------------------------------------------------ */
  // y 軸用整天的資料算一次、之後固定，播放時才不會跳
  const loadRange = useMemo(() => {
    if (!show?.dayAhead || !show?.actual) return { min: 0, max: 1, interval: 0.2 }
    const peak = Math.max(...[...show.actual, ...show.dayAhead].filter((v) => Number.isFinite(v)))
    // 刻度間距和最大值要一起決定，否則最大值不在刻度上，頂端會出現兩個標籤疊在一起。
    // 間距挑 1、2、5 的倍數裡「刻度不超過 6 格」的最小值
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10]
    const interval = steps.find((st) => peak / st <= 6) ?? 10
    return { min: 0, max: Math.ceil(peak / interval) * interval, interval }
  }, [show])

  const loadOption = useMemo(() => {
    if (!show?.dayAhead || !show?.actual) return {}
    const s = curSlot
    const actual = show.actual.map((v, i) => (i <= s ? v : null))
    const line = { type: 'line', smooth: true, symbol: 'none', connectNulls: false }
    return {
      animation: !demo.enabled, // 展示模式每秒更新，動畫會讓「現在」那條線抖
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .filter((p) => p.value != null)
            .map((p) => `${p.marker}${p.seriesName}: ${(+p.value).toFixed(3)} kW`)
            .join('<br/>'),
      },
      legend: { ...baseLegend, data: ['RF 日前預測', '真實值'] },
      grid: { ...baseGrid, right: 24 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW', { min: loadRange.min, max: loadRange.max, interval: loadRange.interval }),
      series: [
        {
          ...line,
          name: 'RF 日前預測',
          data: show.dayAhead,
          lineStyle: { width: 2, type: 'dashed', color: COLORS.load },
          itemStyle: { color: COLORS.load },
          markLine: nowLine(s),
        },
        {
          ...line,
          name: '真實值',
          data: actual,
          lineStyle: { width: 2, color: TEXT_MAIN },
          itemStyle: { color: TEXT_MAIN },
        },
      ],
    }
  }, [show, curSlot, theme, loadRange, demo.enabled])

  const loadStats = useMemo(() => {
    if (!show?.dayAhead || !show?.actual) return null
    const n = curSlot + 1
    const kwh = (arr, m) => arr.slice(0, m).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0) * SLOT_HOURS
    const err = show.dayAhead.slice(0, n).map((v, i) => Math.abs(v - (show.actual[i] ?? v)))
    return {
      fcAll: kwh(show.dayAhead, 96),
      fcNow: kwh(show.dayAhead, n),
      acNow: kwh(show.actual, n),
      mae: err.reduce((a, v) => a + v, 0) / n,
    }
  }, [show, curSlot])

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
          // 手機上儀表只剩一百多 px 寬，10 格刻度的數字會擠成一團，改成 4 格（0、25、50、75、100）
          splitNumber: narrow ? 4 : 10,
          splitLine: { length: 10, lineStyle: { color: TRACK_LINE } },
          axisLabel: { color: AXIS_TEXT, fontSize: 10, distance: 14 },
          pointer: { width: 4, itemStyle: { color: COLORS.battery } },
          anchor: { show: true, size: 10, itemStyle: { color: COLORS.battery } },
          detail: {
            valueAnimation: true,
            // 取整數：數字動畫過程會帶小數（例如 20.8%），和 KPI 卡的「21%」對不上
            formatter: (v) => `${Math.round(v)}%`,
            color: TEXT_MAIN,
            fontSize: narrow ? 22 : 26,
            fontWeight: 'bolder',
            offsetCenter: [0, '55%'],
          },
          data: [{ value: soc }],
        },
      ],
    }
  }, [live, theme, narrow])

  const s = today?.summary
  // 「今日累積」只加到目前這一格；summary 裡的是全天 96 格的預估值
  const soFar = (kw) => ((kw ?? []).slice(0, curSlot + 1).reduce((a, v) => a + v, 0) * SLOT_HOURS).toFixed(1)
  const upTo = slotToTime(curSlot)

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
              ? `今日累積發電 ${soFar(today.pv)} 度`
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
          sub={s ? `今日累積用電 ${soFar(today.load)} 度` : ' '}
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
          label="今日預估省下電費"
          value={s ? s.savings : '—'}
          unit="元"
          sub={s ? `較不裝系統節省 ${s.savingPct}%` : ' '}
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
            <EChart option={gaugeOption} height={210} style={{ flex: 1 }} label={`電池電量儀表，目前 ${live ? live.socPct.toFixed(0) : '—'}%`} />
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
        sub={`今日 00:00 ～ ${upTo}・`
             + (!admin
                ? '太陽能、用電、電網與電池到目前為止的運轉'
                : today && today.loadSource !== 'rf'
                ? '不可轉移負載為模擬值（讀不到雲端預測快照）'
                : '不可轉移負載取當日真實值（隨時間累積）'
                  + (today?.planSource && today.planSource !== 'sim' ? '；電池照排程，與預測的差額由電網補足' : ''))}
        className="mt-16"
        right={
          admin ? (
            <span className="badge">
              {demo.enabled ? '展示模式' : '真實時間'}・第 {curSlot + 1} / 96 格
            </span>
          ) : null
        }
      >
        <EChart option={realtimeOption} height={300 + SOC_EXTRA_HEIGHT} label="即時運轉：今天到目前為止的太陽能、負載、電網、電池功率與 SOC" />
      </Panel>

      {/* 今日全天計畫：前一晚排好、整天不變；和上面那張刻意分開，避免把「已發生」和「還沒發生」混為一談 */}
      <Panel
        title="今日預測與排程"
        sub={!admin
          ? '前一晚排定的全天計畫（用電與發電為預測值），實際運轉見上圖・紅底為尖峰時段'
          : (dayPlan && dayPlan.loadSource !== 'rf'
                ? '負載：模擬值（讀不到雲端預測快照）'
                : '前一晚排定的全天計畫・負載：前一晚 23:45 發布的 RF 日前預測')
             + (dayPlan?.pvSource === 'lstm'
                ? '・太陽能：前一晚 23:45 發布的 LSTM 預測（兩者都一天一次）'
                : '')
             + (!dayPlan
                ? ''
                : dayPlan.planSource !== 'sim'
                ? `・電池：排程組的 ${dayPlan.planSource} 排程（資料集 ${dayPlan.planDate}）`
                : `・電池：模擬調度（${dayPlan.planNote ?? '這個情境還沒有排程組的排程'}）`)
             + '・紅底為尖峰時段'}
        right={
          !dayPlan ? null : dayPlan.loadSource === 'rf' && dayPlan.pvSource === 'lstm' ? (
            admin ? (
              <span className="badge">
                RF + LSTM 雲端預測{dayPlan.planSource !== 'sim' ? ` + ${dayPlan.planSource} 排程` : ''}
              </span>
            ) : null
          ) : (
            // 讀不到快照時各函式會自動退回模擬值，畫面照常運作，但要標出來，免得把模擬曲線當成模型結果
            <span className="badge sim-badge" title="讀不到 public/data 的預測快照，負載或太陽能改用模擬值">
              🧪 {!admin ? '暫時顯示模擬資料' : dayPlan.loadSource === 'rf' ? '負載為雲端預測・太陽能為模擬' : dayPlan.pvSource === 'lstm' ? '太陽能為雲端預測・負載為模擬' : '讀不到雲端預測，顯示模擬資料'}
            </span>
          )
        }
        className="mt-16"
      >
        {/* 住戶看不到下面的「太陽能預測與實際」，天氣條改放在這張圖上方 */}
        {!admin && show?.weather && <WeatherStrip weather={show.weather} />}
        <EChart option={dayPlanOption} height={380 + socExtraHeight(PLAN_SOC_H)} label="今日預測與排程：整天的太陽能、負載、電網、電池功率與 SOC" />
      </Panel>

      {/* 太陽能：預測與實際，上方是同一天台北的實際天氣 */}
      {admin && show?.pv && (
        <Panel
          title="太陽能發電：預測與實際"
          sub={`LSTM 一天預測一次（前一晚 23:45 發布）；實際值由 ERA5 日射量換算，只畫到 ${upTo}`
               + (show.weather ? '；上方為同一天台北的實際天氣' : '')}
          className="mt-16"
          right={<span className="badge">LSTM・資料集 {show.targetDate}</span>}
        >
          {show.weather && <WeatherStrip weather={show.weather} />}
          <EChart option={pvOption} height={260} label="太陽能發電：LSTM 日前預測與實際發電比較" />
          {pvStats && (
            <div className="stat-row">
              <div>
                <span>全日預測</span>
                <strong>{pvStats.fcAll.toFixed(1)} 度</strong>
              </div>
              <div>
                <span>截至 {upTo} 預測</span>
                <strong>{pvStats.fcNow.toFixed(1)} 度</strong>
              </div>
              <div>
                <span>截至 {upTo} 實際</span>
                <strong>{pvStats.acNow == null ? '—' : `${pvStats.acNow.toFixed(1)} 度`}</strong>
              </div>
              <div title="實際發電不到 0.5 度時比例沒有意義，先不計算">
                <span>預測比實際</span>
                <strong>
                  {pvStats.diffPct == null
                    ? '—'
                    : `${pvStats.diffPct >= 0 ? '多' : '少'} ${Math.abs(pvStats.diffPct).toFixed(0)}%`}
                </strong>
              </div>
            </div>
          )}
        </Panel>
      )}

      {/* 不可轉移負載：日前預測與實際（和排程用的是同一次預測） */}
      {admin && show?.dayAhead && show?.actual && (
        <Panel
          title="不可轉移負載：預測與實際"
          sub={`RF 日前預測（前一晚 23:45 發布，一天一次，與排程使用的相同）；真實值只畫到 ${upTo}`}
          className="mt-16"
          right={<span className="badge">RF・資料集 {show.targetDate}</span>}
        >
          <EChart option={loadOption} height={260} label="不可轉移負載：RF 日前預測與真實值比較" />
          {loadStats && (
            <div className="stat-row">
              <div>
                <span>全日預測</span>
                <strong>{loadStats.fcAll.toFixed(1)} 度</strong>
              </div>
              <div>
                <span>截至 {upTo} 預測</span>
                <strong>{loadStats.fcNow.toFixed(1)} 度</strong>
              </div>
              <div>
                <span>截至 {upTo} 實際</span>
                <strong>{loadStats.acNow.toFixed(1)} 度</strong>
              </div>
              <div title="到目前為止每 15 分鐘預測與實際的平均絕對誤差">
                <span>平均誤差（MAE）</span>
                <strong>{loadStats.mae.toFixed(2)} kW</strong>
              </div>
            </div>
          )}
        </Panel>
      )}
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
