/* ============================================================
   頁面四：歷史紀錄

   兩個分頁：
   - 單日紀錄（預設）：某一天完整的運轉紀錄——當天的即時運轉曲線、
     省下多少錢、電費拆解、能源來源與去向、設備與排程、電池與天氣
   - 區間統計：電費帳單式，選一段日期依日／週／月彙整，可匯出日報／月報
   在區間統計點某一天，會跳到那天的單日紀錄。

   資料來源：api/client.js 的 fetchDayActual()／fetchDailyActual()，資料庫的實時運轉紀錄（排程組 MILP
   每 15 分鐘重排、逐秒控制的結果）。平常模式與展示模式相同：日期是展示月 1 日到「今天」的昨天
   （平常模式的今天見 scenario.js 的 todayOf）。展示模式播到月底最後一格（23:45 以後）時，月底這天也列入。
   只收已經結束的日子（到昨天為止）——和電費帳單一樣，今天要到 24:00 才結算。
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import WeatherStrip from '../components/WeatherStrip.jsx'
import { fetchDayActual, fetchDailyActual, fetchPlanVsActual, ymd, parseYmd, addDays } from '../api/client.js'
import { useDataRevision } from '../hooks/useDataRevision.js'
import { useDemoEnabled, useDemoSlot } from '../lib/demoClock.js'
import { useScenarioDays } from '../lib/scenario.js'
import { COLORS, DEVICES, DEVICE_COLORS, BATTERY, SLOTS_PER_DAY, slotToTime } from '../lib/constants.js'
import { TIER_LABEL, getPriceSlots } from '../lib/tou.js'
import { useTheme, getTheme, setTheme } from '../lib/theme.js'
import { toCsv, downloadCsv, printReport, fitChartsOnPrint } from '../lib/exportFile.js'
import { dayRecord } from '../lib/dayRecord.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'

const SHIFT_IDS = new Set(DEVICES.filter((d) => d.category === 'shiftable').map((d) => d.id))

/** 可轉移設備建議範圍以外的時段（小時區間）：照建議時不會用到，使用者可以自己指定 */
function blockedHours(id) {
  const wins = [...(SHIFTABLE_RULES[id]?.windows ?? [[0, 24]])].sort((x, y) => x[0] - y[0])
  const out = []
  let t = 0
  for (const [a, b] of wins) {
    if (a > t) out.push([t, a])
    t = Math.max(t, b)
  }
  if (t < 24) out.push([t, 24])
  return out
}
import {
  baseTooltip,
  baseLegend,
  baseGrid,
  valueYAxis,
  touMarkArea,
  powerSocLayout,
  powerSocFormatter,
  socYAxis,
  SOC_EXTRA_HEIGHT,
  socExtraHeight,
  AXIS_TEXT,
  SPLIT_LINE,
  TRACK_LINE,
} from '../lib/charts.js'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const CMP_SOC_H = 110 // 計畫與實際那張的 SOC 小圖：兩條 SOC 要看得出差距，比一般的高一點
/** 千分位＋固定小數位（區間統計一年份會到上萬度，沒有千分位很難讀） */
const fmt = (v, d) => v.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d })
const weekdayOf = (s) => WEEK[parseYmd(s).getDay()]
/** 'YYYY-MM-DD' 夾在 lo～hi 之間（這種格式的字串直接比大小就是比日期） */
const clampYmd = (s, lo, hi) => (s < lo ? lo : s > hi ? hi : s)
/** 區間統計的預設：「昨天」所在那個月的 1 號到昨天。
    今天是 1 號時昨天屬於上個月，就會自然顯示整個上月，不會出現空區間 */
const thisMonthOf = (y) => ({ from: ymd(new Date(y.getFullYear(), y.getMonth(), 1)), to: ymd(y) })

// 列印時白紙上要看得清楚：夜間模式先切到日間，印完再切回來（不寫入使用者的偏好）
function printInLight() {
  const prev = getTheme()
  printReport(
    () => prev === 'dark' && setTheme('light', { remember: false }),
    () => prev === 'dark' && setTheme('dark', { remember: false })
  )
}

export default function History() {
  const demoOn = useDemoEnabled()
  const { today, next } = useScenarioDays() // 展示模式下跟著播放走；月底沒有隔日（next 是 null）
  // 展示時鐘的「今天」最多到月底那天，只列到昨天的話 7/31、1/31 永遠看不到，整月合計也少一天。
  // 月底這天播到最後一格（23:45 以後；整月播完會停在 23:59:59）就當作已經結束，一起列入。
  // 只看格數（useDemoSlot 進到下一格才重畫），不必每 0.1 秒跟著時鐘重畫整頁
  const demoSlot = useDemoSlot()
  const monthDone = demoOn && !!today && !next && demoSlot >= SLOTS_PER_DAY - 1
  // 展示月 1 日到「今天」的昨天（展示模式月底播完則到月底）。下面沿用 yesterday 這個名字，指的是「可以看的最後一天」
  const [yesterday, minDay] = useMemo(() => {
    const t = parseYmd(today)
    return [monthDone ? t : addDays(t, -1), new Date(t.getFullYear(), t.getMonth(), 1)]
  }, [today, monthDone])
  const [tab, setTab] = useState('day')
  const [day, setDay] = useState(() => ymd(yesterday))
  // 區間統計的起訖與彙整單位放在這一層：點某天進單日紀錄再切回來，自己選的區間還在
  const [range, setRange] = useState(() => thisMonthOf(yesterday))
  const [unit, setUnit] = useState('day')
  // 切換模式、或展示時鐘換天時：原本看的就是「昨天」（沒有自己選別天）就跟著換到新的昨天；
  // 選的日期超出範圍也拉回昨天；其他情況保留使用者選的那天。
  // 區間統計同樣處理：結束日原本是昨天就跟著換，起訖都夾回範圍（展示日往回調時，不會列出「昨天」之後的日子）；
  // 平常↔展示、或換了展示月，區間回到預設的本月
  const scope = `${demoOn ? 'demo' : 'live'}-${ymd(minDay)}`
  const prevScope = useRef(scope)
  const prevYesterday = useRef(ymd(yesterday))
  useEffect(() => {
    const y = ymd(yesterday)
    const lo = ymd(minDay)
    const was = prevYesterday.current
    prevYesterday.current = y
    setDay((d) => (d === was || d > y || d < lo ? y : d))
    if (prevScope.current !== scope) {
      prevScope.current = scope
      setRange(thisMonthOf(yesterday))
      setUnit('day')
    } else {
      setRange(({ from, to }) => ({ from: clampYmd(from, lo, y), to: to === was ? y : clampYmd(to, lo, y) }))
    }
  }, [yesterday, minDay]) // eslint-disable-line react-hooks/exhaustive-deps
  // 列印（按鈕或 Ctrl+P）時圖表照紙張寬度重畫，印完畫回螢幕寬度
  useEffect(() => fitChartsOnPrint(), [])
  const empty = yesterday < minDay // 展示月第一天：還沒有過去的日子

  return (
    <div className="history">
      <div className="tabs no-print" role="tablist">
        <button role="tab" aria-selected={tab === 'day'} className={tab === 'day' ? 'active' : ''} onClick={() => setTab('day')}>
          📅 單日紀錄
        </button>
        <button role="tab" aria-selected={tab === 'range'} className={tab === 'range' ? 'active' : ''} onClick={() => setTab('range')}>
          📊 區間統計
        </button>
      </div>
      {empty ? (
        <Panel>
          <p>今天是展示月第一天（{today}），還沒有過去的日子。</p>
        </Panel>
      ) : tab === 'day' ? (
        <DayView date={day} setDate={setDay} yesterday={yesterday} minDay={minDay} />
      ) : (
        <RangeView
          key={scope}
          yesterday={yesterday}
          minDay={minDay}
          range={range}
          setRange={setRange}
          unit={unit}
          setUnit={setUnit}
          onPickDay={(d) => {
            setDay(d)
            setTab('day')
            window.scrollTo({ top: 0 })
          }}
        />
      )}
    </div>
  )
}

/* ================================================================
   單日紀錄
   ================================================================ */
function DayView({ date, setDate, yesterday, minDay }) {
  const theme = useTheme()
  const [res, setRes] = useState(null)
  const [loadError, setLoadError] = useState(null)
  // 本機重算時每寫回一天就加一：同一天換成新結果時直接換掉，不先清成載入中（畫面不閃）
  const rev = useDataRevision()
  const shown = useRef(null)
  // 同一天的日前計畫（前一晚 23:45 的排程）與實際運轉對照
  const [cmp, setCmp] = useState(null)

  useEffect(() => {
    let on = true
    const key = date
    if (shown.current !== key) {
      setRes(null)
      setLoadError(null)
      setCmp(null)
      shown.current = key
    }
    // 讀取或計算失敗時要顯示原因，不能讓畫面一直停在載入中
    fetchDayActual(date)
      .then((r) => on && setRes(r))
      .catch((e) => on && setLoadError(e?.message ?? String(e)))
    fetchPlanVsActual(date).then((r) => on && setCmp(r)).catch(() => on && setCmp(null))
    return () => { on = false }
  }, [date, rev])

  const sim = res?.sim
  const rec = useMemo(() => (sim ? dayRecord(sim) : null), [sim])
  const s = rec?.summary

  // 用函式形式更新：鍵盤連按時，每一下都要從「最新的日期」往前後推，不能用這次畫面拿到的舊值
  const step = (n) => setDate((cur) => {
    const t = addDays(parseYmd(cur), n)
    return t < minDay || t > yesterday ? cur : ymd(t)
  })
  const atFirst = date <= ymd(minDay)
  const atLast = date >= ymd(yesterday)

  // 鍵盤 ← → 切換前後一天（口試講解時不必去點小按鈕）；游標在輸入框裡（例如日期欄）時不攔截
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const tag = e.target?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable) return
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, minDay, yesterday])

  /* ---- 當天的即時運轉曲線（整天） ---- */
  const curveOption = useMemo(() => {
    if (!sim) return {}
    const line = { type: 'line', smooth: true, symbol: 'none' }
    return {
      tooltip: { ...baseTooltip, formatter: powerSocFormatter },
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      ...powerSocLayout({ boundaryGap: true }),
      yAxis: [valueYAxis('kW'), socYAxis()],
      series: [
        { ...line, name: '太陽能發電', data: sim.pv, lineStyle: { width: 2, color: COLORS.solar }, itemStyle: { color: COLORS.solar }, areaStyle: { color: 'rgba(255,176,32,0.16)' }, markArea: touMarkArea(sim.tier, sim.price) },
        { ...line, name: '家庭負載', data: sim.load, lineStyle: { width: 2, color: COLORS.load }, itemStyle: { color: COLORS.load } },
        { ...line, name: '電網購電', data: sim.gridKw, lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' }, itemStyle: { color: COLORS.grid } },
        { type: 'bar', stack: 'b', name: '電池充電', data: sim.chargeKw, itemStyle: { color: 'rgba(34,197,94,0.55)' } },
        { type: 'bar', stack: 'b', name: '電池放電', data: sim.dischargeKw.map((v) => -v), itemStyle: { color: 'rgba(249,115,22,0.6)' } },
        {
          ...line, name: 'SOC', xAxisIndex: 1, yAxisIndex: 1, data: sim.socPct,
          lineStyle: { width: 2.4, color: COLORS.battery }, itemStyle: { color: COLORS.battery },
          markArea: touMarkArea(sim.tier, sim.price, undefined, { label: false }),
          markLine: {
            silent: true, symbol: 'none', lineStyle: { color: TRACK_LINE, type: 'dashed' },
            label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
            data: [{ yAxis: Math.round(BATTERY.socMax * 100) }, { yAxis: Math.round(BATTERY.socMin * 100) }],
          },
        },
      ],
    }
  }, [sim, theme])

  /* ---- 日前計畫與實際運轉：和主頁面同一種圖，實線＝實際、虛線＝計畫，同一種量同一個顏色 ---- */
  const compareOption = useMemo(() => {
    if (!cmp) return {}
    const { plan: p, actual: a, tier } = cmp
    const line = { type: 'line', smooth: true, symbol: 'none' }
    const act = (id, name, data, color, extra = {}) =>
      ({ ...line, id, name, data, lineStyle: { width: 2.2, color }, itemStyle: { color }, ...extra })
    const pln = (id, name, data, color, extra = {}) =>
      ({ ...line, id, name, data, lineStyle: { width: 1.6, color, type: [6, 4] }, itemStyle: { color }, z: 3, ...extra })
    const soc = { xAxisIndex: 1, yAxisIndex: 1 }
    // 提示框：同一時刻每一項都列「實際｜計畫」，不必滑到那條線上
    const dot = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:5px"></span>`
    const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')
    const formatter = (ps) => {
      const i = ps[0]?.dataIndex
      if (i == null) return ''
      const row = (c, name, x, y, u, lab = '計畫', d = 2) => `${dot(c)}${name}：實際 ${n(x, d)}${u}｜${lab} ${n(y, d)}${u}`
      return [
        ps[0].axisValueLabel,
        row(COLORS.solar, '太陽能', a.pv[i], p.pv[i], ' kW', '預測'),
        row(COLORS.load, '負載', a.load[i], p.load[i], ' kW', '預測'),
        row(COLORS.grid, '購電', a.grid[i], p.grid[i], ' kW'),
        row('rgba(34,197,94,0.8)', '電池（正＝充電）', a.batt[i], p.batt[i], ' kW'),
        row(COLORS.battery, 'SOC', a.soc[i], p.soc[i], '%', '計畫', 0),
      ].join('<br/>')
    }
    return {
      tooltip: { ...baseTooltip, formatter },
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      ...powerSocLayout({ boundaryGap: true, socH: CMP_SOC_H }),
      yAxis: [valueYAxis('kW'), socYAxis({ interval: 25 })],
      series: [
        act('pv-a', '太陽能發電', a.pv, COLORS.solar, { areaStyle: { color: 'rgba(255,176,32,0.14)' }, markArea: touMarkArea(tier, getPriceSlots(parseYmd(date))) }),
        pln('pv-p', '太陽能發電', p.pv, COLORS.solar),
        act('load-a', '家庭負載', a.load, COLORS.load),
        pln('load-p', '家庭負載', p.load, COLORS.load),
        act('grid-a', '電網購電', a.grid, COLORS.grid),
        pln('grid-p', '電網購電', p.grid, COLORS.grid),
        { type: 'bar', id: 'chg', stack: 'b', name: '電池充電', data: a.charge, itemStyle: { color: 'rgba(34,197,94,0.45)' } },
        { type: 'bar', id: 'dis', stack: 'b', name: '電池放電', data: a.discharge.map((v) => -v), itemStyle: { color: 'rgba(249,115,22,0.5)' } },
        act('soc-a', 'SOC', a.soc, COLORS.battery, {
          ...soc,
          markArea: touMarkArea(tier, getPriceSlots(parseYmd(date)), undefined, { label: false }),
          markLine: {
            silent: true, symbol: 'none', lineStyle: { color: TRACK_LINE, type: 'dashed' },
            label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
            data: [{ yAxis: Math.round(BATTERY.socMax * 100) }, { yAxis: Math.round(BATTERY.socMin * 100) }],
          },
        }),
        pln('soc-p', 'SOC', p.soc, COLORS.battery, soc),
      ],
    }
  }, [cmp, theme, date])

  /* ---- 可轉移設備用電排行（不可轉移設備不列） ---- */
  const shiftDevices = useMemo(() => (rec ? rec.devices.filter((d) => SHIFT_IDS.has(d.id)) : []), [rec])
  const deviceOption = useMemo(() => {
    if (!rec) return {}
    const list = [...shiftDevices].reverse() // 橫條圖由下往上畫，反過來才會是「最多的在最上面」
    return {
      tooltip: { ...baseTooltip, trigger: 'item', formatter: (p) => `${p.name}：${(+p.value).toFixed(2)} kWh` },
      grid: { left: 84, right: 56, top: 8, bottom: 20 },
      xAxis: { type: 'value', axisLabel: { color: AXIS_TEXT, fontSize: 11 }, splitLine: { lineStyle: { color: SPLIT_LINE } } },
      yAxis: { type: 'category', data: list.map((d) => d.name), axisLabel: { color: AXIS_TEXT, fontSize: 12 }, axisTick: { show: false }, axisLine: { show: false } },
      series: [{
        type: 'bar',
        data: list.map((d) => ({ value: +d.kwh.toFixed(3), itemStyle: { color: DEVICE_COLORS[d.id], borderRadius: [0, 4, 4, 0] } })),
        barMaxWidth: 16,
        label: { show: true, position: 'right', color: AXIS_TEXT, fontSize: 11, formatter: (p) => `${(+p.value).toFixed(2)}` },
      }],
    }
  }, [rec, shiftDevices, theme])

  /* ---- 匯出當日明細 ---- */
  const exportDay = () => {
    if (!sim) return
    const rows = sim.pv.map((_, i) => ({
      time: `${date} ${slotToTime(i)}`,
      tier: TIER_LABEL[sim.tier[i]] ?? sim.tier[i],
      price: sim.price[i],
      pv: sim.pv[i],
      load: sim.load[i],
      grid: sim.gridKw[i],
      charge: sim.chargeKw[i],
      discharge: sim.dischargeKw[i],
      soc: sim.socPct[i],
      pvSelf: sim.pvToLoad[i],
      pvBatt: sim.pvToBatt[i],
      pvCut: sim.pvToGrid[i],
    }))
    downloadCsv(
      `HEMS_單日紀錄_${date}.csv`,
      toCsv(rows, [
        { key: 'time', label: '時間' },
        { key: 'tier', label: '電價時段' },
        { key: 'price', label: '電價(元/度)', digits: 2 },
        { key: 'pv', label: '太陽能發電(kW)', digits: 3 },
        { key: 'load', label: '家庭負載(kW)', digits: 3 },
        { key: 'grid', label: '電網購電(kW)', digits: 3 },
        { key: 'charge', label: '電池充電(kW)', digits: 3 },
        { key: 'discharge', label: '電池放電(kW)', digits: 3 },
        { key: 'soc', label: 'SOC(%)', digits: 1 },
        { key: 'pvSelf', label: '太陽能直接自用(kW)', digits: 3 },
        { key: 'pvBatt', label: '太陽能充電池(kW)', digits: 3 },
        { key: 'pvCut', label: '太陽能削減(kW)', digits: 3 },
      ])
    )
  }

  const w = sim?.weather?.summary

  return (
    <>
      <div className="print-only report-head">
        <h1>家庭能源管理系統　單日運轉紀錄</h1>
        <p>
          {date}（週{weekdayOf(date)}）・匯出於 {new Date().toLocaleString('zh-TW', { hour12: false })}
        </p>
      </div>

      {/* 日期列 */}
      <Panel className="no-print">
        <div className="history-bar">
          <div className="day-nav">
            <button className="btn" onClick={() => step(-1)} disabled={atFirst} aria-label="前一天" title="前一天（鍵盤 ←）">◀</button>
            <DateInput aria-label="紀錄日期" value={date} min={ymd(minDay)} max={ymd(yesterday)} onChange={setDate} />
            <button className="btn" onClick={() => step(1)} disabled={atLast} aria-label="後一天" title="後一天（鍵盤 →）">▶</button>
            <strong className="day-nav-wd">週{weekdayOf(date)}</strong>
            {w && (
              <span className="day-nav-wx">
                <span className="wx-icon">{w.icon}</span>
                {w.label}・{w.tempMin.toFixed(0)}～{w.tempMax.toFixed(0)}°C・
                {w.precipMm != null ? `雨量 ${w.precipMm} mm` : `降雨機率最高 ${w.popMax}%`}
              </span>
            )}
          </div>
          <div className="export-btns">
            <button className="btn" onClick={exportDay} disabled={!sim}>⬇ 匯出當日明細</button>
            <button className="btn" onClick={printInLight}>🖨 列印／PDF</button>
          </div>
        </div>
      </Panel>

      {loadError ? (
        <LoadError message={loadError} />
      ) : !rec ? (
        <div className="skeleton mt-16" style={{ height: 420 }} />
      ) : (
        <>
          {/* 省下多少錢 */}
          <div className="grid cols-5 mt-16">
            <Tile label="當日電費" value={s.optimizedCost.toFixed(1)} unit="元" />
            <Tile label="原始電費" value={s.baselineCost.toFixed(1)} unit="元" />
            <Tile label="省下電費" value={s.savings.toFixed(1)} unit="元" color={COLORS.save} />
            <Tile label="用電" value={rec.load.toFixed(1)} unit="kWh" color={COLORS.load} />
            <Tile label="太陽能發電" value={rec.pv.toFixed(1)} unit="kWh" color={COLORS.solar} />
          </div>

          {/* 即時運轉曲線 */}
          <Panel
            title="當日即時運轉曲線"
            className="mt-16"
          >
            <WeatherStrip weather={sim.weather} />
            <EChart option={curveOption} height={300 + SOC_EXTRA_HEIGHT} label={`${date} 的運轉曲線：太陽能、負載、電網、電池功率與 SOC`} />
          </Panel>

          {/* 日前計畫與實際運轉：計畫來自排程、實際來自實時運轉紀錄 */}
          {cmp && (
            <Panel
              title="日前計畫與實際運轉"
              className="mt-16 cmp-panel"
            >
              <div className="grid cols-4">
                <Tile label="實際電費" value={cmp.actual.total.cost.toFixed(1)} unit="元" color={COLORS.save} />
                <Tile label="實際購電" value={cmp.actual.total.grid.toFixed(1)} unit="度" color={COLORS.grid} />
                <Tile label="實際用電" value={cmp.actual.total.load.toFixed(1)} unit="度" color={COLORS.load} />
                <Tile label="實際太陽能" value={cmp.actual.total.pv.toFixed(1)} unit="度" color={COLORS.solar} />
              </div>
              <EChart option={compareOption} height={300 + socExtraHeight(CMP_SOC_H)}
                label={`${date} 的日前計畫與實際運轉：太陽能、負載、購電與 SOC 的計畫（虛線）和實際（實線）`} />
            </Panel>
          )}

          <div className="grid cols-2 mt-16">
            {/* 電費拆解 */}
            <Panel title="電費拆解">
              <div className="table-wrap">
                <table className="history-table compact">
                  <thead>
                    <tr>
                      <th>時段</th>
                      <th className="num">電價</th>
                      <th className="num">裝 HEMS</th>
                      <th className="num">原始電費</th>
                      <th className="num">差額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rec.touRows.map((t) => {
                      const diff = t.baseCost - t.hemsCost
                      return (
                        <tr key={t.tier}>
                          <td>
                            <span className={`tier-dot ${t.tier}`} />
                            {TIER_LABEL[t.tier] ?? t.tier}
                          </td>
                          <td className="num">{t.price.toFixed(2)}<span className="tou-break"> 元/度</span></td>
                          <td className="num">{t.hemsKwh.toFixed(1)} 度<br /><strong>{t.hemsCost.toFixed(1)} 元</strong></td>
                          <td className="num dim">{t.baseKwh.toFixed(1)} 度<br />{t.baseCost.toFixed(1)} 元</td>
                          <td className={`num ${diff >= 0 ? 'save' : 'more'}`}>
                            <span className="tou-break">{diff >= 0 ? '省 ' : '多 '}</span>
                            {Math.abs(diff).toFixed(1)} 元
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}>合計</td>
                      <td className="num">{s.optimizedCost.toFixed(1)} 元</td>
                      <td className="num">{s.baselineCost.toFixed(1)} 元</td>
                      <td className="num save"><span className="tou-break">省 </span>{s.savings.toFixed(1)} 元</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>

            {/* 能源來源與去向 */}
            <Panel title="能源來源與去向">
              <StackBar title="家庭用電" total={rec.load} parts={rec.sources} colors={{ pv: COLORS.solar, batt: COLORS.battery, grid: COLORS.grid }} />
              <StackBar title="太陽能發電" total={rec.pv} parts={rec.pvDest} colors={{ self: COLORS.solar, batt: COLORS.battery, cut: '#94a3b8' }} />
            </Panel>
          </div>

          <div className="grid cols-2 mt-16">
            {/* 可轉移設備用電排行 */}
            <Panel title="可轉移設備用電">
              <EChart option={deviceOption} height={Math.max(160, shiftDevices.length * 40)} label={`${date} 可轉移設備用電量`} />
            </Panel>

            {/* 可轉移設備的排程 */}
            <Panel
              title="可轉移設備運轉時段"
            >
              <Timeline runs={rec.runs} tier={sim.tier} />
              <div className="run-list">
                {rec.runs.map((d) => (
                  <div key={d.id} className="run-row">
                    <span className="run-name">{d.icon} {d.name}</span>
                    <span className="run-times">
                      {d.runs.length === 0
                        ? <span className="dim">當日未運轉</span>
                        : d.runs.map((r, i) => (
                          <span key={i} className={`run-chip ${r.allOffpeak ? 'offpeak' : 'peak'}`}>
                            {r.from}–{r.to}・{r.kwh.toFixed(2)} 度・{r.cost.toFixed(1)} 元
                          </span>
                        ))}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          {/* 電池 */}
          <Panel title="電池" className="mt-16">
            <div className="grid cols-6">
              <Tile label="充電" value={rec.battery.chargeKwh.toFixed(2)} unit="kWh" color={COLORS.battery} />
              <Tile label="其中太陽能充電" value={rec.battery.fromPvKwh.toFixed(2)} unit="kWh" color={COLORS.solar} />
              <Tile label="放電" value={rec.battery.dischargeKwh.toFixed(2)} unit="kWh" color="#f97316" />
              <Tile label="等效循環" value={rec.battery.cycles.toFixed(2)} unit="次" />
              <Tile label="SOC 最高" value={rec.battery.socMax.toFixed(0)} unit="%" />
              <Tile label="SOC 最低" value={rec.battery.socMin.toFixed(0)} unit="%" />
            </div>
          </Panel>

        </>
      )}
    </>
  )
}

/**
 * 日期欄。瀏覽器的 min／max 只管日曆選單，擋不住直接用鍵盤打：原本打出範圍外的日期（未來、展示日之後）
 * 會直接去讀那天，年份打到一半（0002-07-20、0201-07-20…）每按一鍵就讀一次、閃出錯誤訊息。
 *   - 打完整的日期才交出去（onChange），範圍外的夾回最近的可選日（例如只能到 07/19 時打 07/25 → 07/19）
 *   - 還沒打完的（清掉某一段、年份不到四位數）只留在欄位裡，不去讀資料；離開欄位時恢復成目前的日期
 */
function DateInput({ value, min, max, onChange, ...rest }) {
  // 欄位上正在打的內容：受控元件要跟著使用者打的字走，否則 React 會把沒打完的年份蓋回去，年份就打不進去
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const change = (v) => {
    if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(v)) {
      setDraft(v)
      return
    }
    const ok = clampYmd(v, min, max)
    setDraft(ok)
    if (ok !== value) onChange(ok)
  }
  return (
    <input
      type="date"
      className="date-input"
      value={draft}
      min={min}
      max={max}
      title={`可選 ${min} ～ ${max}`}
      onChange={(e) => change(e.target.value)}
      onBlur={() => setDraft(value)}
      {...rest}
    />
  )
}

/** 紀錄讀取或計算失敗時的說明（取代一直轉圈的載入畫面） */
function LoadError({ message }) {
  return (
    <section className="panel error-panel load-error mt-16" role="alert">
      <h3>用電紀錄暫時無法顯示</h3>
      <p className="hint prose">{'讀取或計算紀錄時發生問題，可能是資料檔格式有誤。可以換一個日期或重新整理再試一次。'}</p>
      <details>
        <summary>錯誤訊息</summary>
        <pre>{message}</pre>
      </details>
    </section>
  )
}

/** 一條 100% 的堆疊橫條：各段寬度依占比 */
function StackBar({ title, total, parts, colors }) {
  return (
    <div className="stackbar">
      <div className="stackbar-head">
        <span>{title}</span>
        <strong>{total.toFixed(2)} kWh</strong>
      </div>
      <div className="stackbar-track">
        {parts.map((p) => {
          const pct = total > 0 ? (p.kwh / total) * 100 : 0
          return pct > 0.05 ? (
            <div key={p.key} className="stackbar-seg" style={{ width: `${pct}%`, background: colors[p.key] }} title={`${p.label} ${p.kwh.toFixed(2)} kWh（${pct.toFixed(1)}%）`}>
              {pct >= 12 && `${pct.toFixed(0)}%`}
            </div>
          ) : null
        })}
      </div>
      <div className="stackbar-legend">
        {parts.map((p) => (
          <span key={p.key}>
            <i style={{ background: colors[p.key] }} />
            {p.label} {p.kwh.toFixed(2)} kWh
            <span className="dim">（{total > 0 ? ((p.kwh / total) * 100).toFixed(1) : 0}%）</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** 24 小時時間軸：每台可轉移設備一條，運轉區段以色塊標出，底色為尖峰時段 */
function Timeline({ runs, tier }) {
  const peakRuns = []
  let st = null
  tier.forEach((t, i) => {
    if (t === 'peak' && st === null) st = i
    if (t !== 'peak' && st !== null) { peakRuns.push([st, i]); st = null }
  })
  if (st !== null) peakRuns.push([st, tier.length])
  const pct = (slot) => `${(slot / SLOTS_PER_DAY) * 100}%`

  return (
    <div className="timeline">
      {runs.map((d) => (
        <div key={d.id} className="tl-row">
          <span className="tl-name">{d.name}</span>
          <div className="tl-track">
            {blockedHours(d.id).map(([a, b], i) => (
              <div key={`b${i}`} className="tl-blocked" style={{ left: `${(a / 24) * 100}%`, width: `${((b - a) / 24) * 100}%` }} />
            ))}
            {peakRuns.map(([a, b], i) => (
              <div key={`p${i}`} className="tl-peak" style={{ left: pct(a), width: pct(b - a) }} />
            ))}
            {d.runs.map((r, i) => (
              <div key={i} className="tl-run" style={{ left: pct(r.start), width: pct(r.end - r.start), background: DEVICE_COLORS[d.id] }} title={`${d.name} ${r.from}–${r.to}`} />
            ))}
          </div>
        </div>
      ))}
      <div className="tl-row tl-axis">
        <span className="tl-name" />
        <div className="tl-track bare">
          {[0, 6, 12, 18, 24].map((h) => (
            <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>
          ))}
        </div>
      </div>
      <div className="tl-legend">
        <span><i className="tl-peak-swatch" />尖峰時段</span>
        <span><i className="tl-blocked-swatch" />建議範圍外（照建議時不會用到）</span>
      </div>
    </div>
  )
}

/* ================================================================
   區間統計（電費帳單式）
   ================================================================ */
const UNITS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '週' },
  { key: 'month', label: '月' },
]
const FIELDS = ['loadKwh', 'pvKwh', 'gridKwh', 'dischargeKwh', 'cost', 'baseline', 'savings']

function mondayOf(d) {
  const back = (d.getDay() + 6) % 7 // 週一 = 0
  return addDays(d, -back)
}
function groupRows(rows, unit) {
  if (unit === 'day') {
    return rows.map((r) => ({
      ...r,
      key: r.date,
      label: `${r.date.slice(5).replace('-', '/')}（${WEEK[r.weekday]}）`,
      days: 1,
    }))
  }
  const map = new Map()
  for (const r of rows) {
    const d = parseYmd(r.date)
    const key = unit === 'week' ? ymd(mondayOf(d)) : r.date.slice(0, 7)
    if (!map.has(key)) map.set(key, { key, first: r.date, last: r.date, days: 0, ...Object.fromEntries(FIELDS.map((f) => [f, 0])) })
    const g = map.get(key)
    g.last = r.date
    g.days += 1
    for (const f of FIELDS) g[f] += r[f]
  }
  return [...map.values()].map((g) => ({
    ...g,
    // 這一週／這個月完整應該有幾天；區間頭尾常常只涵蓋一部分，長條會比較矮
    full: unit === 'week' ? 7 : new Date(+g.key.slice(0, 4), +g.key.slice(5, 7), 0).getDate(),
    // 區間頭尾可能只涵蓋半週，標籤寫實際涵蓋的日期，不寫整週
    label:
      unit === 'week'
        ? `${g.first.slice(5).replace('-', '/')} ～ ${g.last.slice(5).replace('-', '/')}`
        : `${g.key.slice(0, 4)} 年 ${Number(g.key.slice(5))} 月`,
  }))
}
const total = (rows) => Object.fromEntries(FIELDS.map((f) => [f, rows.reduce((a, r) => a + r[f], 0)]))

/* 起訖（range）與彙整單位（unit）由上層保存：切到單日紀錄時這個元件會卸載，切回來還是原本選的區間 */
function RangeView({ yesterday, minDay, range, setRange, unit, setUnit, onPickDay }) {
  const theme = useTheme()
  const { from, to } = range
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const rev = useDataRevision() // 本機重算時每寫回一天就加一，區間統計跟著換成新結果

  useEffect(() => {
    let on = true
    const [a, b] = from <= to ? [from, to] : [to, from] // 起訖選反了就自動對調
    setLoadError(null)
    fetchDailyActual(a, b)
      .then((d) => on && setData(d))
      .catch((e) => on && setLoadError(e?.message ?? String(e)))
    return () => { on = false }
  }, [from, to, rev])

  const rows = data?.rows ?? []
  const groups = useMemo(() => groupRows(rows, unit), [rows, unit])
  const sum = useMemo(() => total(rows), [rows])


  const lo = ymd(minDay)
  const hi = ymd(yesterday)

  /* 原本是「kWh 長條＋電費折線」共用一張圖、左右兩個 y 軸：兩把尺各自縮放，
     線和長條的高低關係沒有意義，看起來卻像可以比。拆成兩張，各用自己的單位。 */
  const catAxis = useMemo(() => ({
    type: 'category',
    data: groups.map((g) => g.label),
    axisLine: { lineStyle: { color: SPLIT_LINE } },
    axisTick: { show: false },
    axisLabel: { color: AXIS_TEXT, fontSize: 11, hideOverlap: true },
  }), [groups, theme])
  const dense = groups.length > 45 // 長條太多時拿掉間距，不然擠成一片
  // 提示框標題：不完整的週／月註明實際天數，免得以為那個月用電特別少
  const periodTitle = (ps) => {
    const g = groups[ps[0]?.dataIndex]
    const note = g?.full && g.days < g.full ? `（區間只涵蓋 ${g.days} 天）` : ''
    return `${ps[0].axisValueLabel}${note}<br/>`
  }
  const barGaps = { barGap: dense ? '0%' : '15%', barCategoryGap: dense ? '10%' : '30%' }

  // 用電、太陽能發電、向電網購電（kWh）
  const energyOption = useMemo(() => {
    if (!groups.length) return {}
    const bar = { type: 'bar', ...barGaps }
    const top = { borderRadius: [3, 3, 0, 0] }
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) => periodTitle(ps) +
          ps.map((p) => `${p.marker}${p.seriesName}: ${fmt(+p.value, 2)} kWh`).join('<br/>'),
      },
      legend: { ...baseLegend, data: ['用電', '太陽能發電', '向電網購電'] },
      grid: { ...baseGrid, bottom: 44 },
      xAxis: catAxis,
      yAxis: valueYAxis('kWh'),
      series: [
        { ...bar, name: '用電', data: groups.map((g) => +g.loadKwh.toFixed(2)), itemStyle: { color: COLORS.load, ...top } },
        { ...bar, name: '太陽能發電', data: groups.map((g) => +g.pvKwh.toFixed(2)), itemStyle: { color: COLORS.solar, ...top } },
        { ...bar, name: '向電網購電', data: groups.map((g) => +g.gridKwh.toFixed(2)), itemStyle: { color: COLORS.grid, ...top } },
      ],
    }
  }, [groups, theme, catAxis])

  // 電費（元）：一根長條的總高 = 原始電費（不裝系統、全部向台電買），下段是實際付的、上段是省下的
  const costOption = useMemo(() => {
    if (!groups.length) return {}
    const bar = { type: 'bar', stack: 'cost', ...barGaps }
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) => {
          const val = (name) => +(ps.find((p) => p.seriesName === name)?.value ?? 0)
          return periodTitle(ps) +
            ps.map((p) => `${p.marker}${p.seriesName}: ${fmt(+p.value, 1)} 元`).join('<br/>') +
            `<br/>原始電費: ${fmt(val('實際電費') + val('省下電費'), 1)} 元`
        },
      },
      legend: { ...baseLegend, data: ['實際電費', '省下電費'] },
      grid: { ...baseGrid, bottom: 44 },
      xAxis: catAxis,
      yAxis: valueYAxis('元'),
      series: [
        { ...bar, name: '實際電費', data: groups.map((g) => +g.cost.toFixed(1)), itemStyle: { color: COLORS.grid } },
        { ...bar, name: '省下電費', data: groups.map((g) => +g.savings.toFixed(1)), itemStyle: { color: COLORS.save, borderRadius: [3, 3, 0, 0] } },
      ],
    }
  }, [groups, theme, catAxis])

  const [a, b] = from <= to ? [from, to] : [to, from]
  const COLS = (first) => [
    { key: 'label', label: first },
    { key: 'loadKwh', label: '用電(kWh)', digits: 2 },
    { key: 'pvKwh', label: '太陽能發電(kWh)', digits: 2 },
    { key: 'gridKwh', label: '向電網購電(kWh)', digits: 2 },
    { key: 'dischargeKwh', label: '電池放電(kWh)', digits: 2 },
    { key: 'cost', label: '電費(元)', digits: 1 },
    { key: 'baseline', label: '原始電費(元)', digits: 1 },
    { key: 'savings', label: '省下電費(元)', digits: 1 },
  ]
  const withTotal = (list, name) => [...list, { label: name, ...total(list) }]
  const exportDaily = () => {
    const list = groupRows(rows, 'day').map((r) => ({ ...r, label: `${r.date}（${WEEK[r.weekday]}）` }))
    downloadCsv(`HEMS_用電日報_${a}_${b}.csv`, toCsv(withTotal(list, '合計'), COLS('日期')))
  }
  const exportMonthly = () => {
    const list = groupRows(rows, 'month').map((g) => ({ ...g, label: `${g.label}（${g.days} 天）` }))
    downloadCsv(`HEMS_用電月報_${a}_${b}.csv`, toCsv(withTotal(list, '合計'), COLS('月份')))
  }

  const unitLabel = UNITS.find((u) => u.key === unit).label

  return (
    <>
      <div className="print-only report-head">
        <h1>家庭能源管理系統　用電紀錄</h1>
        <p>
          區間 {a} ～ {b}（{rows.length} 天）・依{unitLabel}彙整・匯出於{' '}
          {new Date().toLocaleString('zh-TW', { hour12: false })}
        </p>
      </div>

      <Panel className="no-print">
        <div className="history-bar">
          <div className="history-filters">
            <label className="field">
              <span>開始</span>
              <DateInput value={from} min={lo} max={hi} onChange={(v) => setRange((r) => ({ ...r, from: v }))} />
            </label>
            <span className="dim">～</span>
            <label className="field">
              <span>結束</span>
              <DateInput value={to} min={lo} max={hi} onChange={(v) => setRange((r) => ({ ...r, to: v }))} />
            </label>
            <div className="seg" role="group" aria-label="彙整單位">
              {UNITS.map((u) => (
                <button key={u.key} className={unit === u.key ? 'active' : ''} onClick={() => setUnit(u.key)}>
                  {u.label}
                </button>
              ))}
            </div>
          </div>
          <div className="export-btns">
            <button className="btn" onClick={exportDaily} title="區間內每天一列">⬇ 匯出日報</button>
            <button className="btn" onClick={exportMonthly} title="區間內每月一列">⬇ 匯出月報</button>
            <button className="btn" onClick={printInLight} title="用瀏覽器列印，可選「另存為 PDF」">🖨 列印／PDF</button>
          </div>
        </div>
      </Panel>

      {loadError ? (
        <LoadError message={loadError} />
      ) : !data ? (
        <div className="skeleton mt-16" style={{ height: 320 }} />
      ) : (
        <>
          <div className="grid cols-6 mt-16">
            <Tile label="區間用電" value={fmt(sum.loadKwh, 1)} unit="kWh" color={COLORS.load} />
            <Tile label="太陽能發電" value={fmt(sum.pvKwh, 1)} unit="kWh" color={COLORS.solar} />
            <Tile label="向電網購電" value={fmt(sum.gridKwh, 1)} unit="kWh" color={COLORS.grid} />
            <Tile label="電費" value={Math.round(sum.cost).toLocaleString()} unit="元" />
            <Tile label="原始電費" value={Math.round(sum.baseline).toLocaleString()} unit="元" />
            <Tile label="省下電費" value={Math.round(sum.savings).toLocaleString()} unit="元" color={COLORS.save} />
          </div>

          <div className="grid cols-2 mt-16">
            <Panel title={`用電、發電與購電（依${unitLabel}）`}>
              <EChart option={energyOption} height={300} label={`${a} 到 ${b} 的用電、發電與購電長條圖`} />
            </Panel>
            <Panel title={`電費（依${unitLabel}）`}>
              <EChart option={costOption} height={300} label={`${a} 到 ${b} 的電費長條圖，分成實際電費與省下電費`} />
            </Panel>
          </div>

          <Panel title={`用電明細（依${unitLabel}）`} className="mt-16">
            <div className="table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>{unit === 'day' ? '日期' : unit === 'week' ? '週' : '月份'}</th>
                    {unit !== 'day' && <th className="num">天數</th>}
                    <th className="num">用電 kWh</th>
                    <th className="num">太陽能 kWh</th>
                    <th className="num">購電 kWh</th>
                    <th className="num">電費</th>
                    <th className="num">原始電費</th>
                    <th className="num">省下</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr
                      key={g.key}
                      className={[
                        unit === 'day' && (g.weekday === 0 || g.weekday === 6) ? 'weekend' : '',
                        unit === 'day' ? 'clickable' : '',
                      ].join(' ')}
                      onClick={unit === 'day' ? () => onPickDay(g.date) : undefined}
                      // 可點的日期列也要能用鍵盤選到（Tab）並打開（Enter／空白鍵）
                      tabIndex={unit === 'day' ? 0 : undefined}
                      onKeyDown={unit === 'day' ? (e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return
                        e.preventDefault()
                        onPickDay(g.date)
                      } : undefined}
                    >
                      <td>{g.label}</td>
                      {unit !== 'day' && <td className="num">{g.days}</td>}
                      <td className="num">{fmt(g.loadKwh, 2)}</td>
                      <td className="num">{fmt(g.pvKwh, 2)}</td>
                      <td className="num">{fmt(g.gridKwh, 2)}</td>
                      <td className="num">{fmt(g.cost, 1)} 元</td>
                      <td className="num dim">{fmt(g.baseline, 1)} 元</td>
                      <td className="num save">{fmt(g.savings, 1)} 元</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>合計</td>
                    {unit !== 'day' && <td className="num">{rows.length}</td>}
                    <td className="num">{fmt(sum.loadKwh, 2)}</td>
                    <td className="num">{fmt(sum.pvKwh, 2)}</td>
                    <td className="num">{fmt(sum.gridKwh, 2)}</td>
                    <td className="num">{fmt(sum.cost, 1)} 元</td>
                    <td className="num">{fmt(sum.baseline, 1)} 元</td>
                    <td className="num save">{fmt(sum.savings, 1)} 元</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  )
}
