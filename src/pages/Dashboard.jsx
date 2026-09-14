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
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK,
  TRACK_LINE,
} from '../lib/charts.js'

/** 時間線標籤的對齊：清晨往右長、深夜往左長，才不會壓到左上角的軸名「kW」或超出右邊界 */
function edgeAlign(s) {
  return s < 24 ? 'left' : s > 72 ? 'right' : 'center'
}

/** 「現在」那條垂直線（滾動預測、太陽能預測與實際兩張圖共用） */
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

export default function Dashboard() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const demo = useDemoClock()
  const now = useClock() // 展示模式開著時，這個已經是虛擬時間
  const curSlot = useCurrentSlot() // 過去／未來的分界，也決定滾動預測取哪一筆
  const { season } = useScenario() // 夏月／非夏月情境，一換就整頁重抓
  const narrow = useMediaQuery('(max-width: 760px)')
  // 住戶看不到預測模型相關的圖與資料來源標示，說明文字也改成一般用語
  const admin = useIsAdmin()

  // kW 軸的範圍「只增不減」，而且兩個情境各記各的。
  // 滾動預測每前進一格就換一次資料，若讓軸自動縮放，播放時整張圖會不停上下跳，
  // 前後時刻也沒辦法比較。記住看過的最大／最小值，軸就只會變寬不會變窄。
  const kwRange = useRef({})
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null)
  const [show, setShow] = useState(null) // 展示日的原始陣列（滾動預測、太陽能預測與實際）

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
  // RF 是滾動預測（每 15 分鐘重發未來 96 步），所以「未來」那段會隨時間更新；
  // 「過去」那段吃的是真實值、不會變，dispatch 又是照時間順序推的，
  // 因此已經發生的電池／電網軌跡自然凍住，不需要另外處理。
  useEffect(() => {
    let on = true
    fetchToday(now, curSlot).then((d) => on && setToday(d))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled, season])

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
       upTo 有值  → 只畫到第 upTo 格（之後補 null），曲線隨時間長出來
       upTo 為 null → 整天都畫，並在展示模式下標出目前播到哪

     x 軸兩張都保持完整的 24 小時，即時那張才不會邊播邊縮放。
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
    const key = today.season ?? 'summer'
    const prev = kwRange.current[key] ?? { min: 0, max: 0 }
    const { min: kwMin, max: kwMax } = (kwRange.current[key] = {
      max: Math.max(prev.max, Math.ceil(Math.max(0, ...all))),
      min: Math.min(prev.min, Math.floor(Math.min(0, ...all))),
    })
    // 刻度間距挑 1、2、5、10 裡「不超過 7 格」的最小值，上下限對齊到間距上；
    // 直接拿資料的最大最小值當上下限，軸上會出現 8、6、3、0、-3、-5 這種不等距的刻度
    const kwStep = [1, 2, 5, 10].find((st) => (kwMax - kwMin) / st <= 7) ?? 10
    const kwAxis = {
      min: Math.floor(kwMin / kwStep) * kwStep,
      max: Math.ceil(kwMax / kwStep) * kwStep,
      interval: kwStep,
    }
    return {
      // 展示模式每秒換一次資料：保留動畫的話，每次更新都會重播一段進場，
      // 播放頭的時間標籤看起來會一直抖。真實時間模式更新慢，動畫留著比較順
      animation: !demo.enabled,
      tooltip: { ...baseTooltip, formatter: powerSocFormatter },
      color: [COLORS.solar, COLORS.load, COLORS.grid, 'rgba(34,197,94,0.55)', 'rgba(249,115,22,0.6)', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      // 功率在上、SOC 在下面一小格，不再共用一張圖的左右兩條 y 軸（見 charts.js 的 powerSocLayout）
      ...powerSocLayout(),
      yAxis: [valueYAxis('kW', kwAxis), socYAxis()],
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
          xAxisIndex: 1,
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: clip(today.socPct),
          lineStyle: { width: 2.5, color: COLORS.battery },
          markArea: peakMarkArea(today.tier),
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
    () => dayOption(curSlot, false),
    [today, theme, curSlot]
  )
  const dayPlanOption = useMemo(
    () => dayOption(null, true),
    [today, theme, demo.enabled, demo.slot]
  )

  /* ------------------------------------------------------------
     太陽能：LSTM 日前預測 vs 實際

     發電量預測一天只發一次（前一晚 23:45），整天用的都是同一條曲線，
     所以這張不像負載那樣有「滾動」，重點是預測和實際差多少。
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
     滾動預測：把「不同時間點發布的預測」並排畫出來

     為什麼需要獨立一張：滾動在「今日預測與排程」那張圖上幾乎看不出來。
     實測相鄰兩次刷新對同一時刻平均只差 0.015 kW，差異只佔軸高約 0.2%。
     這張只畫不可轉移負載、用它自己的尺度，滾動才看得見。

       紫色實線  現在這一格發布的最新預測
       淡色虛線  1～4 小時前發布的預測（越舊越淡）
       實線      當天真實值（只畫到現在，未來還不知道）
     ------------------------------------------------------------ */
  // y 軸用整份資料算一次、之後固定，播放時才不會跳
  const rollRange = useMemo(() => {
    if (!show?.rolling || !show?.actual) return { min: 0, max: 1, interval: 0.2 }
    const vals = [...show.actual, ...show.rolling.flat()].filter((v) => Number.isFinite(v))
    const peak = Math.max(...vals)
    // 刻度間距和最大值要一起決定，否則最大值不在刻度上，頂端會出現兩個標籤疊在一起。
    // 間距挑 1、2、5 的倍數裡「刻度不超過 6 格」的最小值
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10]
    const interval = steps.find((st) => peak / st <= 6) ?? 10
    return { min: 0, max: Math.ceil(peak / interval) * interval, interval }
  }, [show])

  const rollingOption = useMemo(() => {
    if (!show?.rolling || !show?.actual) return {}
    const s = curSlot
    // 第 iss 格發布的那次預測，攤回一日 96 格；發布之前的時段沒有值
    const issued = (iss) => {
      const row = show.rolling[iss]
      return Array.from({ length: 96 }, (_, i) =>
        row && i > iss ? (row[i - iss - 1] ?? null) : null
      )
    }
    const earlier = [16, 12, 8, 4].map((k) => s - k).filter((x) => x >= 0)
    const actual = show.actual.map((v, i) => (i <= s ? v : null))
    const base = { type: 'line', smooth: true, symbol: 'none', connectNulls: false }

    // tooltip 要標出每條虛線是幾點發布的，但圖例不能每格都換名字（會一直閃），
    // 所以圖例統一叫「較早的預測」，發布時間另外記在這裡給 tooltip 用
    const issueOf = [...earlier, s, null]

    return {
      animation: !demo.enabled, // 展示模式每秒更新，動畫會讓「現在」那條線抖
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .filter((p) => p.value != null)
            .map((p) => {
              const iss = issueOf[p.seriesIndex]
              const who =
                iss == null ? '真實值' : iss === s ? `${slotToTime(iss)} 發布（最新）` : `${slotToTime(iss)} 發布`
              return `${p.marker}${who}: ${(+p.value).toFixed(3)} kW`
            })
            .join('<br/>'),
      },
      // 01:00 以前還沒有「1 小時前發布」的預測可畫，圖例不能列出不存在的系列（ECharts 會警告）
      legend: { ...baseLegend, data: ['真實值', '最新預測', ...(earlier.length ? ['較早的預測'] : [])] },
      grid: { ...baseGrid, right: 24 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW', { min: rollRange.min, max: rollRange.max, interval: rollRange.interval }),
      series: [
        ...earlier.map((iss, j) => ({
          ...base,
          name: '較早的預測',
          data: issued(iss),
          // j 越大越接近現在：越新越清楚
          lineStyle: { width: 1.2, type: 'dashed', color: COLORS.load, opacity: 0.2 + j * 0.15 },
          itemStyle: { color: COLORS.load, opacity: 0.45 },
        })),
        {
          ...base,
          name: '最新預測',
          // 從「現在」這一點接出去：預測本來就是站在目前已知的資料往後推，
          // 不接的話真實值和預測中間會斷一格，看起來像少了資料
          data: issued(s).map((v, i) => (i === s ? (show.actual[s] ?? v) : v)),
          lineStyle: { width: 2.6, color: COLORS.load },
          itemStyle: { color: COLORS.load },
          markLine: nowLine(s),
        },
        {
          ...base,
          name: '真實值',
          data: actual,
          lineStyle: { width: 2, color: TEXT_MAIN },
          itemStyle: { color: TEXT_MAIN },
        },
      ],
    }
  }, [show, curSlot, theme, rollRange, demo.enabled])

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
                : '不可轉移負載取當日真實值（隨時間累積）')}
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

      {/* 預測與排程：整天都畫，和上面那張刻意分開，避免把「已發生」和「還沒發生」混為一談 */}
      <Panel
        title="今日預測與排程"
        sub={!admin
          ? '已經過去的時段是實際運轉，之後是預測與排程・紅底為尖峰時段'
          : (today && today.loadSource !== 'rf'
                ? '負載：模擬值（讀不到雲端預測快照）'
                : `負載：過去用真實值、未來用 ${upTo} 發布的最新一次 RF 預測重新規劃`)
             + (today?.pvSource === 'lstm'
                ? '・太陽能：前一晚 23:45 發布的 LSTM 預測（一天一次）'
                : '')
             + '・紅底為尖峰時段'}
        right={
          !today ? null : today.loadSource === 'rf' && today.pvSource === 'lstm' ? (
            admin ? <span className="badge">RF + LSTM 雲端預測</span> : null
          ) : (
            // 讀不到快照時各函式會自動退回模擬值，畫面照常運作，但要標出來，免得把模擬曲線當成模型結果
            <span className="badge sim-badge" title="讀不到 public/data 的預測快照，負載或太陽能改用模擬值">
              🧪 {!admin ? '暫時顯示模擬資料' : today.loadSource === 'rf' ? '負載為雲端預測・太陽能為模擬' : today.pvSource === 'lstm' ? '太陽能為雲端預測・負載為模擬' : '讀不到雲端預測，顯示模擬資料'}
            </span>
          )
        }
        className="mt-16"
      >
        {/* 住戶看不到下面的「太陽能預測與實際」，天氣條改放在這張圖上方 */}
        {!admin && show?.weather && <WeatherStrip weather={show.weather} />}
        <EChart option={dayPlanOption} height={300 + SOC_EXTRA_HEIGHT} label="今日預測與排程：整天的太陽能、負載、電網、電池功率與 SOC" />
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

      {/* 滾動預測：同一段未來在不同時間點被預測成什麼樣子 */}
      {admin && show?.rolling && show?.actual && (
        <Panel
          title="不可轉移負載滾動預測"
          sub={`RF 每 15 分鐘重發一次未來 24 小時的預測・紫色實線為 ${upTo} 發布的最新一次，淡色虛線為 1～4 小時前發布的`}
          className="mt-16"
          right={<span className="badge">RF 雲端預測・資料集 {show.targetDate}</span>}
        >
          <EChart option={rollingOption} height={260} label="不可轉移負載滾動預測：真實值、最新預測與較早發布的預測" />
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
