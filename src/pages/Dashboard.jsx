import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import EnergyFlow from '../components/EnergyFlow.jsx'
import SecondReplay from '../components/SecondReplay.jsx'
import WeatherStrip from '../components/WeatherStrip.jsx'
import { fetchLive, fetchToday, fetchShowcase, fetchRolling, fetchPast24, fetchTodaySoFar, parseYmd } from '../api/client.js'
import { useDataRevision } from '../hooks/useDataRevision.js'
import { COLORS, BATTERY, SLOT_HOURS, slotToTime } from '../lib/constants.js'
import { getTierSlots, getPriceSlots } from '../lib/tou.js'
import { useTheme } from '../lib/theme.js'
import { useDemoEnabled, useDemoSlot, useDemoDay, slotToDate } from '../lib/demoClock.js'
import { useScenario } from '../lib/scenario.js'
import { useSlotClock, useCurrentSlot } from '../hooks/useClock.js'
import { useMediaQuery } from '../hooks/useMediaQuery.js'
import { useIsAdmin } from '../lib/auth.js'
import {
  slotXAxis,
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  touMarkArea,
  SOC_EXTRA_HEIGHT,
  socExtraHeight,
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK,
  TRACK_LINE,
} from '../lib/charts.js'
import { PLAN_SOC_H, edgeAlign, allKw, niceAxis, powerSocOption, rollingOption, past24Option } from '../lib/planChart.js'

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

/* 計畫那張圖看哪一段：next24＝從現在起 24 小時（每 15 分鐘隨實時運轉層重排更新，預設）、today＝今日全天（前一晚的日前計畫）。
   記在瀏覽器裡，只是個人偏好；讀寫失敗（無痕、封鎖儲存）就用預設 */
const VIEW_KEY = 'hems:plan-view'
const PLAN_VIEWS = [{ key: 'next24', label: '未來 24 小時' }, { key: 'today', label: '今日全天' }]
function loadView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'today' ? 'today' : 'next24'
  } catch {
    return 'next24'
  }
}

export default function Dashboard() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  // 展示時鐘每 0.1 秒前進一次；這頁只在開關與換格時重畫
  const demo = { enabled: useDemoEnabled(), slot: Math.max(0, useDemoSlot()), day: useDemoDay() }
  const now = useSlotClock() // 展示模式開著時是虛擬時間；換格時才變
  const curSlot = useCurrentSlot() // 過去（真實值）／未來（日前預測）的分界
  const { season } = useScenario() // 夏月／非夏月情境，一換就整頁重抓
  const rev = useDataRevision() // 本機重算時每寫回一天就加一：今天那份換新了要重抓
  const narrow = useMediaQuery('(max-width: 760px)')
  const midWidth = useMediaQuery('(max-width: 1280px)') // 電池儀表刻度數用
  // 住戶看不到預測模型相關的圖與資料來源標示，說明文字也改成一般用語
  const admin = useIsAdmin()

  // 即時運轉那張的 kW 軸「只增不減」，兩個情境各記各的。
  // 每前進一格整張往左捲一格、資料跟著換，若讓軸自動縮放，播放時整張圖會不停上下跳。
  // 計畫那張資料固定，軸直接依自己的資料決定，不和即時那張共用。
  const kwRange = useRef({})
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null) // 今天：過去是實際、之後是計畫（流向圖的今日預估省下電費）
  const [past, setPast] = useState(null) // 即時運轉：管理員看過去 24 小時、住戶看今天到現在的實時運轉紀錄
  const [dayPlan, setDayPlan] = useState(null) // 前一晚排定的全天計畫（今日全天用）
  const [rolling, setRolling] = useState(null) // 從現在起 24 小時的計畫（未來 24 小時用）
  const [planView, setPlanView] = useState(loadView)
  const pickView = (v) => {
    setPlanView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* 存不了就只在這次有效 */
    }
  }
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
  }, [demo.enabled, demo.slot, demo.day, curSlot, season])

  // 今天：到這一格為止照實時運轉紀錄、之後照這一格重排的計畫；每前進一格就重算一次（今日預估省下電費用）
  useEffect(() => {
    let on = true
    fetchToday(now, curSlot).then((d) => on && setToday(d))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled, demo.day, season, rev])

  // 即時運轉：管理員看過去 24 小時（每前進一格往左捲一格），住戶只看今天 00:00 到現在
  useEffect(() => {
    let on = true
    const get = admin ? fetchPast24 : fetchTodaySoFar
    get(curSlot).then((d) => on && setPast(d)).catch(() => on && setPast(null))
    return () => { on = false }
  }, [admin, curSlot, demo.enabled, demo.day, season, rev])

  // 今日全天計畫：排程一天只排一次，整天都是同一份（負載、太陽能都用前一晚的日前預測）
  useEffect(() => {
    let on = true
    fetchToday(now).then((d) => on && setDayPlan(d))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo.enabled, demo.day, season, rev])

  // 未來 24 小時：每前進一格換一份（實時運轉層在這一格重排的計畫）
  useEffect(() => {
    if (planView !== 'next24') return undefined
    let on = true
    fetchRolling(curSlot).then((d) => on && setRolling(d)).catch(() => on && setRolling(null))
    return () => { on = false }
  }, [curSlot, demo.enabled, demo.day, season, planView, rev])

  // 展示日原始資料：每個情境載入一次，之後只是依目前格數取不同的列
  useEffect(() => {
    let on = true
    fetchShowcase().then((d) => on && setShow(d))
    return () => { on = false }
  }, [season, demo.enabled, demo.day])

  // ---- 即時運轉：管理員是過去 24 小時（右端是現在）、住戶是今天 00:00～24:00（畫到現在） ----
  // kW 軸只增不減（整張往左捲或往右長時軸不跳）；兩種版本、兩個情境各記各的
  const realtimeAxis = (d) => {
    const vals = allKw(d)
    const key = `${d.season ?? 'summer'}-${d.labels ? 'past24' : 'today'}`
    const prev = kwRange.current[key] ?? { min: 0, max: 0 }
    const r = (kwRange.current[key] = {
      max: Math.max(prev.max, Math.max(0, ...vals)),
      min: Math.min(prev.min, Math.min(0, ...vals)),
    })
    return niceAxis(r.min, r.max)
  }
  // 曲線的右端就是現在：直接在尖端標名稱與目前的數值（幾條線擠在一起時只靠圖例分不出誰是誰）
  const TIP = { '太陽能發電': ['太陽能', COLORS.solar], '家庭負載': ['負載', COLORS.load], '電網購電': ['購電', COLORS.grid], SOC: ['SOC', COLORS.battery] }
  const realtimeOption = useMemo(() => {
    if (!past || past.source === 'none') return {}
    const o = past.labels
      ? past24Option(past, { kwAxis: realtimeAxis(past), animation: !demo.enabled })
      : powerSocOption(past, {
        playhead: past.endSlot, playheadLabel: `${demo.enabled ? '' : '現在 '}${slotToTime(past.endSlot)}`,
        kwAxis: realtimeAxis(past), animation: !demo.enabled,
      })
    const right = narrow ? 58 : 76
    o.grid = o.grid.map((g) => ({ ...g, right }))
    o.series = o.series.map((x) => {
      const t = TIP[x.name]
      if (!t) return x
      const [text, color] = t
      // SOC 的 90%／15% 參考線標籤改放左邊：右端是曲線尖端的標籤，SOC 接近上下限時兩者會疊在一起
      const ref = x.markLine?.label ? { markLine: { ...x.markLine, label: { ...x.markLine.label, position: 'insideStartTop' } } } : {}
      return {
        ...x,
        ...ref,
        endLabel: {
          show: true, color, fontSize: 11, fontWeight: 700, distance: 6,
          formatter: (p) => (x.name === 'SOC' ? `${text} ${Math.round(p.value)}%` : `${text} ${(+p.value).toFixed(1)}`),
        },
        labelLayout: { moveOverlap: 'shiftY' },
      }
    })
    return o
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, theme, narrow, demo.enabled])

  // ---- 計畫：今日全天（前一晚的日前計畫，標出現在）或未來 24 小時（實時運轉層在這一格重排的計畫） ----
  const dayPlanOption = useMemo(() => {
    if (!dayPlan) return {}
    const vals = allKw(dayPlan)
    return powerSocOption(dayPlan, {
      playhead: curSlot, playheadLabel: `${demo.enabled ? '' : '現在 '}${slotToTime(curSlot)}`,
      kwAxis: niceAxis(Math.min(0, ...vals), Math.max(0, ...vals), 10), detail: true, animation: !demo.enabled,
    })
  }, [dayPlan, theme, demo.enabled, curSlot])
  const hasRolling = planView === 'next24' && rolling && rolling.source !== 'none' && rolling.season === season
  const next24Option = useMemo(() => (hasRolling ? rollingOption(rolling) : {}), [rolling, hasRolling, theme])
  const planOption = hasRolling ? next24Option : dayPlanOption

  // 預測與實際那兩張的背景電價（展示日那天）
  const showTou = useMemo(() => {
    if (!show?.targetDate) return null
    const t = parseYmd(show.targetDate)
    return touMarkArea(getTierSlots(t), getPriceSlots(t))
  }, [show, theme])

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
          markArea: showTou ?? undefined,
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
  }, [show, curSlot, theme, demo.enabled, showTou])

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
          markArea: showTou ?? undefined,
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
  }, [show, curSlot, theme, loadRange, demo.enabled, showTou])

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
          // 儀表寬度跟著版面欄寬走，不是視窗寬：1280 以下兩欄並排時儀表只剩約 150px，10 格刻度會疊在一起
          splitNumber: narrow ? 4 : midWidth ? 5 : 10,
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
  }, [live, theme, narrow, midWidth])

  const upTo = slotToTime(curSlot)

  return (
    <>
      {/* 流向（含今日預估省下電費）＋電池 */}
      <div className="grid cols-2">
        <Panel title="能源即時流向">
          <EnergyFlow live={live} savings={today?.summary?.savings ?? null} />
        </Panel>
        <Panel title="電池狀態" style={{ display: 'flex', flexDirection: 'column' }}>
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

      {/* 即時運轉：管理員看過去 24 小時（右端是現在，每 15 分鐘往左捲一格）；住戶只看今天，畫到現在 */}
      <Panel title={admin ? '即時運轉（過去 24 小時）' : '即時運轉（今日）'} className="mt-16">
        <EChart option={realtimeOption} height={300 + SOC_EXTRA_HEIGHT}
          label={admin
            ? '即時運轉：過去 24 小時的太陽能、負載、電網、電池功率與 SOC'
            : '即時運轉：今天 00:00 到現在的太陽能、負載、電網、電池功率與 SOC'} />
      </Panel>

      {/* 秒級重播（管理員）：資料集的秒級資料（跟著網站部署，不經過資料庫）；一般模式跟著真實時間、展示模式跟著展示時鐘 */}
      {admin && (
        <div className="mt-16">
          <SecondReplay />
        </div>
      )}

      {/* 計畫：預設看「從現在起 24 小時」（實時運轉層每 15 分鐘重排的計畫），可切回今日全天（前一晚的日前計畫） */}
      <Panel
        title={hasRolling ? '未來 24 小時預測與排程' : '今日預測與排程'}
        right={
          <div className="seg" role="group" aria-label="計畫的時間範圍">
            {PLAN_VIEWS.map((v) => (
              <button key={v.key} className={planView === v.key ? 'active' : ''} aria-pressed={planView === v.key}
                onClick={() => pickView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
        }
        className="mt-16"
      >
        {/* 住戶看不到下面的「太陽能預測與實際」，天氣條改放在這張圖上方（天氣條是今天 00:00～24:00，只配今日全天） */}
        {!admin && show?.weather && !hasRolling && <WeatherStrip weather={show.weather} />}
        <EChart option={planOption} height={380 + socExtraHeight(PLAN_SOC_H)}
          label={hasRolling
            ? '未來 24 小時預測與排程：從現在起 24 小時的太陽能、負載、電網、電池功率與 SOC'
            : '今日預測與排程：整天的太陽能、負載、電網、電池功率與 SOC'} />
      </Panel>

      {/* 太陽能：預測與實際，上方是同一天台北的實際天氣 */}
      {admin && show?.pv && (
        <Panel title="太陽能發電：預測與實際" className="mt-16">
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
        <Panel title="不可轉移負載：預測與實際" className="mt-16">
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
