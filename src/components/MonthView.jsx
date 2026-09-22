import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from './Panel'
import EChart from './EChart'
import Tile from './Tile'
import { cached, refreshCached, fetchSchedules, fetchOperation, SCHEDULES_REFRESHED } from '../api/forecastData'
import { loadPrefs, PREFS_SAVED } from '../api/prefs.js'
import { useScenario, useScenarioDays } from '../lib/scenario.js'
import { useTheme } from '../lib/theme.js'
import { DEVICES } from '../lib/constants.js'
import { baseTooltip, baseLegend, valueYAxis, AXIS_TEXT, SPLIT_LINE } from '../lib/charts.js'

/* 整月排程與實時運轉：兩個展示月（2010-07、2010-01）每一天的日前排程與實時運轉接成一條時間軸。

   使用者只能調整隔日（展示日的下一天：7/20、1/12）的可轉移設備。按下儲存之後，本機的 watch_prefs.py
   從隔日起一天一天重算那個月（電量一天接一天，只能依序算），算完一天就寫回資料庫；今天以前的不動。
   這裡每 5 秒重讀一次，看得到隔日以後的曲線一天一天換成新設定；灰色是按下儲存之前的樣子，拿來對照。

   哪一天已經是新設定：排程與實時運轉每天都記著自己是用哪一版設定算的（prefs_stamp），
   受影響的日子（changed_from 起、同一個月）和目前設定的版本（GET /prefs 的 stamp）相同才算。
   changed_from 是空的代表原本的設定整個換掉，兩個月每一天都要重算。
   沒有後端 API（只有快照）時不輪詢，也不顯示進度。 */

const MONTHS = {
  summer: { month: '2010-07', name: '7 月' },
  non_summer: { month: '2010-01', name: '1 月' },
}
const POLL_MS = 5000
const STALL_MS = 3 * 60 * 1000 // 3 分鐘都沒有任何一天更新，就當作本機沒在算，停止輪詢
const SLOT_MS = 15 * 60 * 1000
const WEEK = '日一二三四五六'
const RATED_KW = Object.fromEntries(
  DEVICES.filter((d) => d.category === 'shiftable').map((d) => [d.id, d.ratedW / 1000]))

// 依角色配色（dataviz 參考色盤前三色，深淺兩種底色都通過色盲檢查）：
// 實時運轉＝藍、日前排程＝橙（虛線）、可轉移設備＝青綠；改設定前一律灰色細線
const PALETTE = {
  dark: { rt: '#3987e5', plan: '#d95926', dev: '#199e70', before: '#8d95a8', weekend: 'rgba(255,255,255,0.04)' },
  light: { rt: '#2a78d6', plan: '#eb6834', dev: '#1baf7a', before: '#8f96a3', weekend: 'rgba(15,23,42,0.045)' },
}

const sum = (a) => a.reduce((x, y) => x + y, 0)
const round = (v, n = 2) => (v == null ? null : +v.toFixed(n))

function monthDays(month) {
  const [y, m] = month.split('-').map(Number)
  const n = new Date(y, m, 0).getDate()
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
}

const dayStart = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}
const md = (date) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`
const weekday = (date) => new Date(dayStart(date)).getDay()

/** 一天的整理：排程與實時的電費、可轉移設備功率、是不是目前的設定 */
function dayInfo(date, plan, op, stamp) {
  const price = plan?.price
  const devKw = plan
    ? Array.from({ length: 96 }, (_, i) => Object.entries(plan.devices ?? {})
        .reduce((a, [id, on]) => a + (on?.[i] ? (RATED_KW[id] ?? 0) : 0), 0))
    : null
  return {
    date,
    plan,
    op,
    devKw,
    planCost: plan ? sum(plan.grid_buy_kw.map((g, i) => g * price[i])) * 0.25 : null,
    rtCost: op && price ? sum(op.grid_kw.map((g, i) => g * price[i])) * 0.25 : null,
    rtKwh: op ? sum(op.grid_kw) * 0.25 : null,
    devKwh: devKw ? sum(devKw) * 0.25 : null,
    fresh: Boolean(stamp) && plan?.prefs_stamp === stamp && op?.prefs_stamp === stamp,
  }
}

function monthInfo(month, data, stamp) {
  if (!data) return null
  return monthDays(month).map((d) => dayInfo(d, data.sched[d], data.op[d], stamp))
}

const total = (days, k) => (days?.every((d) => d[k] != null) ? sum(days.map((d) => d[k])) : null)

/** 時間軸上的點：kW 這類平均值掛在該格開始；SOC 是該格結束時的電量，掛在結束 */
function lines(days) {
  const socPlan = []
  const socRt = []
  const gridRt = []
  const gridPlan = []
  const dev = []
  for (const d of days) {
    const t0 = dayStart(d.date)
    if (d.plan) {
      // 日前排程每天從前一天實際的電量重新排：每天一段，中間斷開，不把前一天的計畫連過來
      socPlan.push([t0, d.plan.start_soc_pct ?? null])
      d.plan.soc_pct.forEach((v, k) => socPlan.push([t0 + (k + 1) * SLOT_MS, v]))
      socPlan.push([t0 + 96 * SLOT_MS, null])
      d.plan.grid_buy_kw.forEach((v, k) => gridPlan.push([t0 + k * SLOT_MS, v]))
      d.devKw.forEach((v, k) => dev.push([t0 + k * SLOT_MS, round(v, 3)]))
    }
    if (d.op) {
      d.op.soc_pct.forEach((v, k) => socRt.push([t0 + (k + 1) * SLOT_MS, v]))
      d.op.grid_kw.forEach((v, k) => gridRt.push([t0 + k * SLOT_MS, v]))
    }
  }
  return { socPlan, socRt, gridRt, gridPlan, dev }
}

/** 週末（週六 00:00～週一 00:00）的淡色底，看得出週末沒有尖峰電價、電費比較低 */
function weekendAreas(days) {
  const out = []
  for (const d of days) {
    if (weekday(d.date) !== 6 && !(weekday(d.date) === 0 && d === days[0])) continue
    const t0 = dayStart(d.date)
    const end = Math.min(t0 + (weekday(d.date) === 6 ? 2 : 1) * 96 * SLOT_MS,
      dayStart(days[days.length - 1].date) + 96 * SLOT_MS)
    out.push([{ xAxis: t0 }, { xAxis: end }])
  }
  return out
}

const fmtTime = (t) => {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const signed = (v, unit, n = 2) => (v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(n)} ${unit}`)

export default function MonthView() {
  const theme = useTheme()
  const C = PALETTE[theme === 'light' ? 'light' : 'dark']
  const { season } = useScenario()
  const cur = MONTHS[season] ?? MONTHS.summer
  const other = MONTHS[season === 'summer' ? 'non_summer' : 'summer']

  const [data, setData] = useState(null) // { sched: {date: 排程}, op: {date: 實時}, via }
  const [stamp, setStamp] = useState(null) // 目前設定的版本
  const [changedFrom, setChangedFrom] = useState(null) // 最近一次改的是哪天起（null＝整個換掉）
  const { today, next } = useScenarioDays() // 展示模式下跟著播放走；月底沒有隔日（next＝null）
  const [before, setBefore] = useState(null) // 按下儲存前的 data，灰線對照用
  const [watching, setWatching] = useState(false)
  const [stalled, setStalled] = useState(false)
  const dataRef = useRef(null)
  dataRef.current = data
  const watchingRef = useRef(false)
  watchingRef.current = watching
  const lastChange = useRef(Date.now())

  // 初次載入：排程、實時運轉、目前設定的版本
  useEffect(() => {
    let on = true
    Promise.all([
      cached('schedule', fetchSchedules).catch(() => null),
      cached('operation', fetchOperation).catch(() => null),
      loadPrefs().catch(() => null),
    ]).then(([s, o, p]) => {
      if (!on) return
      setData({ sched: s?.byDate ?? {}, op: o?.byDate ?? {}, via: s?.via ?? o?.via ?? null })
      setStamp(p?.stamp ?? null)
      setChangedFrom(p?.changedFrom ?? null)
    })
    return () => { on = false }
  }, [])

  // 上面按下「儲存給排程」：記下現在的樣子當對照，開始追蹤本機重算的進度。
  // 前一次還沒算完又存一次時，對照維持最早那份（中途的資料是新舊混在一起的）
  useEffect(() => {
    const onSaved = (e) => {
      setBefore((b) => (b && watchingRef.current ? b : dataRef.current))
      if (e.detail?.stamp) setStamp(e.detail.stamp)
      setChangedFrom(e.detail?.from ?? null)
      setStalled(false)
      lastChange.current = Date.now()
      setWatching(true)
    }
    window.addEventListener(PREFS_SAVED, onSaved)
    return () => window.removeEventListener(PREFS_SAVED, onSaved)
  }, [])

  const days = useMemo(() => monthInfo(cur.month, data, stamp), [cur.month, data, stamp])
  const otherDays = useMemo(() => monthInfo(other.month, data, stamp), [other.month, data, stamp])
  const beforeDays = useMemo(() => monthInfo(cur.month, before, null), [cur.month, before])
  // 這次改設定影響到哪幾天：changed_from 起、同一個月；沒有 changed_from＝兩個月每一天
  const affected = (d) => (changedFrom
    ? d.date.slice(0, 7) === changedFrom.slice(0, 7) && d.date >= changedFrom
    : true)
  const curAff = days?.filter(affected) ?? []
  const otherAff = otherDays?.filter(affected) ?? []
  const fresh = curAff.filter((d) => d.fresh).length
  const otherFresh = otherAff.filter((d) => d.fresh).length
  const allFresh = Boolean(days && otherDays) && fresh === curAff.length && otherFresh === otherAff.length
  const live = data?.via === 'api' && Boolean(stamp)

  // 進頁面時就有舊設定的日子（例如別的分頁剛存過、本機正在算）：也開始追蹤
  useEffect(() => {
    if (live && !allFresh && !stalled) setWatching(true)
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps

  // 有一天更新就重設「多久沒動靜」的計時；兩個月都算完就停止輪詢
  useEffect(() => {
    lastChange.current = Date.now()
    if (allFresh) setWatching(false)
  }, [fresh, otherFresh, allFresh])

  useEffect(() => {
    if (!watching) return undefined
    let on = true
    const tick = async () => {
      if (Date.now() - lastChange.current > STALL_MS) {
        setWatching(false)
        setStalled(true)
        return
      }
      const [s, o] = await Promise.all([
        refreshCached('schedule', fetchSchedules).catch(() => null),
        refreshCached('operation', fetchOperation).catch(() => null),
      ])
      if (!on || (!s && !o)) return
      setData((d) => ({ sched: s?.byDate ?? d?.sched ?? {}, op: o?.byDate ?? d?.op ?? {}, via: s?.via ?? d?.via }))
      if (s) window.dispatchEvent(new CustomEvent(SCHEDULES_REFRESHED, { detail: s }))
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { on = false; clearInterval(id) }
  }, [watching])

  /* ---- 縮放：滑鼠滾輪／下方拖曳條，或點下面的每日長條直接放大那一天 ----
     每 5 秒更新資料時圖會重畫，縮放範圍要記在 ref 裡帶進新的 option，不然會跳回整月 */
  const zoomRef = useRef({ start: 0, end: 100 })
  const [zoomTick, setZoomTick] = useState(0)
  const [zoomed, setZoomed] = useState(false) // 「看整月」按鈕要不要出現
  const zoomTo = (start, end) => {
    zoomRef.current = { start, end }
    setZoomed(end - start < 99.9)
    setZoomTick((t) => t + 1)
  }
  useEffect(() => { zoomTo(0, 100) }, [season])

  const t0 = days ? dayStart(days[0].date) : 0
  const t1 = days ? dayStart(days[days.length - 1].date) + 96 * SLOT_MS : 0

  const mainOption = useMemo(() => {
    if (!days?.some((d) => d.plan || d.op)) return {}
    const L = lines(days)
    const B = beforeDays ? lines(beforeDays) : null
    // 同一個角色（實時運轉、日前排程、改設定前）在兩格裡的線用同一個名字：圖例只有四項，
    // 點一下同時切換兩格；提示框用 id 分出是 SOC 還是購電
    const line = (id, name, data, color, grid, { lineStyle, ...rest } = {}) => ({
      id, name, type: 'line', data, xAxisIndex: grid, yAxisIndex: grid, showSymbol: false,
      lineStyle: { width: 1.5, color, ...lineStyle }, itemStyle: { color }, ...rest,
    })
    const shade = { silent: true, itemStyle: { color: C.weekend }, data: weekendAreas(days) }
    // 今天和隔日的分界：使用者只能改隔日，這條線左邊（今天以前）改了設定也不會動
    const nextLine = (label) => next && ({
      silent: true, symbol: 'none', lineStyle: { color: AXIS_TEXT, type: 'dashed', width: 1 },
      label: { show: label, formatter: '隔日', color: AXIS_TEXT, fontSize: 10, position: 'end', distance: 2 },
      data: [{ xAxis: dayStart(next) }],
    })
    const series = [
      line('soc-rt', '實時運轉', L.socRt, C.rt, 0, { z: 3, markArea: shade, markLine: nextLine(true) }),
      line('soc-plan', '日前排程', L.socPlan, C.plan, 0, { lineStyle: { width: 1.2, type: 'dashed' }, z: 2 }),
      line('dev', '可轉移設備', L.dev, C.dev, 1, {
        step: 'start', lineStyle: { width: 0 }, areaStyle: { color: C.dev, opacity: 0.35 }, z: 0, markArea: shade,
        markLine: nextLine(false),
      }),
      B && line('soc-before', '改設定前', B.socRt, C.before, 0, { lineStyle: { width: 1 }, z: 1 }),
      B && line('dev-before', '改設定前', B.dev, C.before, 1, { step: 'start', lineStyle: { width: 1, type: 'dashed' }, z: 1 }),
      B && line('grid-before', '改設定前', B.gridRt, C.before, 1, { step: 'start', lineStyle: { width: 1 }, z: 1 }),
      line('grid-plan', '日前排程', L.gridPlan, C.plan, 1, { step: 'start', lineStyle: { width: 1, type: 'dashed' }, z: 2 }),
      line('grid-rt', '實時運轉', L.gridRt, C.rt, 1, { step: 'start', lineStyle: { width: 1.3 }, z: 3 }),
    ].filter(Boolean)
    const LABEL = {
      'soc-rt': 'SOC・實時運轉', 'soc-plan': 'SOC・日前排程', 'soc-before': 'SOC・改設定前',
      dev: '可轉移設備', 'dev-before': '設備・改設定前',
      'grid-rt': '購電・實時運轉', 'grid-plan': '購電・日前排程', 'grid-before': '購電・改設定前',
    }
    const ORDER = Object.keys(LABEL)
    const timeAxis = (grid, show) => ({
      type: 'time', gridIndex: grid, min: t0, max: t1,
      axisLine: { lineStyle: { color: SPLIT_LINE } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        show, color: AXIS_TEXT, fontSize: 11, hideOverlap: true,
        formatter: { year: '{yyyy}', month: '{M}/{d}', day: '{M}/{d}', hour: '{HH}:{mm}', minute: '{HH}:{mm}' },
      },
    })
    const { start, end } = zoomRef.current
    return {
      animation: false,
      legend: { ...baseLegend, data: [...new Set(series.map((s) => s.name))] },
      tooltip: {
        ...baseTooltip,
        formatter: (ps) => {
          const list = ps.filter((p) => p.value?.[1] != null)
            .sort((a, b) => ORDER.indexOf(a.seriesId) - ORDER.indexOf(b.seriesId))
          if (!list.length) return ''
          return `${fmtTime(list[0].value[0])}<br/>` + list.map((p) => {
            const soc = p.seriesId.startsWith('soc')
            return `${p.marker}${LABEL[p.seriesId]}：${soc ? `${(+p.value[1]).toFixed(1)}%` : `${(+p.value[1]).toFixed(2)} kW`}`
          }).join('<br/>')
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        // 窄螢幕圖例換行時 EChart 會把第一格往下推一行（22px），兩格之間要留得下
        { left: 48, right: 16, top: 58, height: 145 },
        { left: 48, right: 16, top: 262, height: 120 },
      ],
      xAxis: [timeAxis(0, false), timeAxis(1, true)],
      yAxis: [
        valueYAxis('SOC %', { gridIndex: 0, min: 0, max: 100, interval: 25 }),
        valueYAxis('kW', { gridIndex: 1, min: 0 }),
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start, end, minValueSpan: 6 * 3600 * 1000 },
        {
          type: 'slider', xAxisIndex: [0, 1], start, end, height: 18, bottom: 8,
          textStyle: { color: AXIS_TEXT, fontSize: 10 }, borderColor: SPLIT_LINE,
          labelFormatter: (v) => fmtTime(v).replace(/（.）/, ' '),
        },
      ],
      series,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, beforeDays, theme, zoomTick, next])

  const dailyOption = useMemo(() => {
    if (!days?.some((d) => d.rtCost != null || d.planCost != null)) return {}
    const pending = `${C.rt}59` // 還是舊設定的日子：同色、淡一點
    const series = [
      {
        name: '實時運轉', type: 'bar', barMaxWidth: 16, barGap: '-100%', z: 2,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        data: days.map((d) => ({
          value: round(d.rtCost), itemStyle: { color: !live || d.fresh || !affected(d) ? C.rt : pending },
        })),
        // 今天以前（使用者改不到、也不會重排的日子）淡淡的底色
        markArea: {
          silent: true, itemStyle: { color: C.weekend },
          label: { show: true, position: 'insideTop', formatter: '今天以前不動', color: AXIS_TEXT, fontSize: 10 },
          data: [[{ xAxis: md(days[0].date) }, { xAxis: md(today) }]],
        },
      },
      beforeDays && {
        name: '改設定前', type: 'bar', barMaxWidth: 16, barGap: '-100%', z: 3, silent: true,
        itemStyle: { color: 'transparent', borderColor: C.before, borderWidth: 1.5, borderType: 'dashed' },
        data: beforeDays.map((d) => round(d.rtCost)),
      },
      {
        name: '日前排程', type: 'line', z: 4, symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 1.3, type: 'dashed', color: C.plan }, itemStyle: { color: C.plan },
        data: days.map((d) => round(d.planCost)),
      },
      beforeDays && {
        name: '改設定前', type: 'line', z: 3, showSymbol: false,
        lineStyle: { width: 1, type: 'dotted', color: C.before }, itemStyle: { color: C.before },
        data: beforeDays.map((d) => round(d.planCost)),
      },
    ].filter(Boolean)
    return {
      animation: false,
      legend: { ...baseLegend, data: [...new Set(series.map((s) => s.name))] },
      tooltip: {
        ...baseTooltip,
        axisPointer: { type: 'shadow' },
        formatter: (ps) => {
          const d = days[ps[0].dataIndex]
          const b = beforeDays?.[ps[0].dataIndex]
          const row = (label, v, bv) => (v == null ? '' : `<br/>${label}：${v.toFixed(2)} 元`
            + (bv != null && Math.abs(v - bv) >= 0.005 ? `（改設定前 ${bv.toFixed(2)}，${signed(v - bv, '元')}）` : ''))
          const state = d.date <= today ? '<br/>今天以前：改設定也不重排'
            : !live || !affected(d) ? '' : d.fresh ? '<br/>✓ 已是目前的設定' : '<br/>⏳ 還是舊設定（重算中）'
          return `${md(d.date)}（${WEEK[weekday(d.date)]}）${row('實時運轉', d.rtCost, b?.rtCost)}`
            + `${row('日前排程', d.planCost, b?.planCost)}${state}<br/><span style="opacity:.7">點一下放大這一天</span>`
        },
      },
      grid: { left: 48, right: 16, top: 44, bottom: 28 },
      xAxis: {
        type: 'category', data: days.map((d) => md(d.date)),
        axisLine: { lineStyle: { color: SPLIT_LINE } }, axisTick: { show: false },
        axisLabel: { color: AXIS_TEXT, fontSize: 10, hideOverlap: true },
      },
      yAxis: valueYAxis('元', { min: 0 }),
      series,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, beforeDays, theme, live, changedFrom, today])

  const dailyEvents = useMemo(() => ({
    click: (p) => {
      if (p.componentType !== 'series' || !days) return
      const n = days.length
      zoomTo((p.dataIndex / n) * 100, ((p.dataIndex + 1) / n) * 100)
    },
  }), [days])
  const mainEvents = useMemo(() => ({
    datazoom: (_p, chart) => {
      const dz = chart.getOption().dataZoom?.[0]
      if (!dz) return
      zoomRef.current = { start: dz.start, end: dz.end } // 只記下來，不重畫（重畫會打斷正在拖的縮放）
      setZoomed(dz.end - dz.start < 99.9)
    },
  }), [])

  /* ---- 摘要與進度 ---- */
  const sums = days && {
    rt: total(days, 'rtCost'), plan: total(days, 'planCost'), kwh: total(days, 'rtKwh'), dev: total(days, 'devKwh'),
  }
  const bsums = beforeDays && {
    rt: total(beforeDays, 'rtCost'), plan: total(beforeDays, 'planCost'),
    kwh: total(beforeDays, 'rtKwh'), dev: total(beforeDays, 'devKwh'),
  }
  const vs = (k, unit) => (bsums?.[k] != null && sums?.[k] != null
    ? `改設定前 ${bsums[k].toFixed(unit === '度' ? 1 : 0)}・${signed(sums[k] - bsums[k], unit, unit === '度' ? 1 : 2)}`
    : null)

  let status = null
  if (live && days) {
    const here = curAff.length > 0
    if (allFresh) {
      status = (
        <span className="month-status done">
          {changedFrom && here ? `✓ ${md(changedFrom)} 起已是新設定・${md(today)} 以前不動` : '✓ 已是目前的設定'}
        </span>
      )
    } else if (watching) {
      status = (
        <span className="month-status busy" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {!changedFrom
            ? `重算中：${cur.name} ${fresh}/${curAff.length} 天・${other.name} ${otherFresh}/${otherAff.length} 天`
            : here
              ? `重算中：${md(changedFrom)} 起 ${fresh}/${curAff.length} 天（${md(today)} 以前不動）`
              : `${other.name}重算中（${otherFresh}/${otherAff.length} 天）・${cur.name}沒有變動`}
        </span>
      )
    } else {
      status = (
        <span className="month-status warn" role="status">
          ⚠ 還有 {curAff.length - fresh + otherAff.length - otherFresh} 天是舊設定（本機的 watch_prefs.py 沒有在跑？）
          <button className="btn-link" onClick={() => { setStalled(false); lastChange.current = Date.now(); setWatching(true) }}>
            再檢查
          </button>
        </span>
      )
    }
  }

  const title = `整月排程與實時運轉・2010 年 ${cur.name}`
  if (!data) {
    return <Panel title={title} className="mt-16"><div className="skeleton" style={{ height: 420 }} /></Panel>
  }
  if (!days.some((d) => d.plan || d.op)) {
    return <Panel title={title} className="mt-16"><div className="muted">這個月還沒有排程與實時運轉的資料。</div></Panel>
  }

  return (
    <Panel
      title={title}
      sub={`${days.length} 天、每 15 分鐘一點・今天 ${md(today)}，${next ? `只能調整隔日 ${md(next)}` : '已到月底，沒有隔日'}・藍＝實時運轉、橙虛線＝日前排程${before ? '、灰＝按下儲存之前' : ''}・淡色底為週末`}
      className="mt-16"
      right={
        <div className="month-ctl">
          {status}
          {zoomed && <button className="btn" onClick={() => zoomTo(0, 100)}>看整月</button>}
          {before && <button className="btn" onClick={() => setBefore(null)} title="不再顯示灰色的對照線">清除對照</button>}
        </div>
      }
    >
      <div className="grid cols-4">
        <Tile label="實時運轉電費" value={sums.rt?.toFixed(0) ?? '—'} unit="元" color={C.rt} sub={vs('rt', '元') ?? '整月實際向電網購電的電費'} />
        <Tile label="日前排程電費" value={sums.plan?.toFixed(0) ?? '—'} unit="元" color={C.plan} sub={vs('plan', '元') ?? '照前一晚的預測排的計畫'} />
        <Tile label="實時向電網購電" value={sums.kwh?.toFixed(0) ?? '—'} unit="度" color={C.rt} sub={vs('kwh', '度')} />
        <Tile label="可轉移設備用電" value={sums.dev?.toFixed(1) ?? '—'} unit="度" color={C.dev} sub={vs('dev', '度') ?? '照上面存下的時段，每天都一樣'} />
      </div>
      <EChart
        option={mainOption}
        height={432}
        onEvents={mainEvents}
        label={`2010 年 ${cur.name}整月的電池 SOC 與向電網購電：日前排程與實時運轉${before ? '，含改設定前的對照' : ''}`}
      />
      <EChart
        option={dailyOption}
        height={230}
        onEvents={dailyEvents}
        label={`2010 年 ${cur.name}每天的電費：實時運轉與日前排程`}
      />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        日前排程用前一晚的負載與發電量預測排電池；實時運轉每 15 分鐘從實際電量重新規劃、逐秒控制，
        面對的是實際負載，所以兩者電費不同。使用者只能調整隔日；存下後本機從隔日起逐日重算那個月
        （電量一天接一天，7 月約 25 秒、1 月約 1 分鐘），今天以前已經排好、跑過的不動。
        這裡每 5 秒更新一次；還沒算到的日子長條較淡。
        滑鼠滾輪或下方拖曳條可以縮放，點每日長條直接放大那一天。
      </p>
    </Panel>
  )
}
