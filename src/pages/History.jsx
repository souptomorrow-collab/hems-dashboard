/* ============================================================
   頁面四：歷史紀錄

   兩個分頁：
   - 單日紀錄（預設）：某一天完整的運轉紀錄——當天的即時運轉曲線、
     省下多少錢、電費拆解、能源來源與去向、設備與排程、電池、減碳與天氣
   - 區間統計：電費帳單式，選一段日期依日／週／月彙整，可匯出日報／月報
   在區間統計點某一天，會跳到那天的單日紀錄。

   資料來源見 api/client.js 的 fetchDaySim()／fetchDailyUsage()：系統尚未接
   實際電表，每一天是用同一套模擬引擎依當日天氣與電價重跑的紀錄；
   不可轉移負載採用資料集中同一個星期幾的實測曲線。畫面上會標明。
   只收已經結束的日子（到昨天為止）——和電費帳單一樣，今天要到 24:00 才結算。
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import WeatherStrip from '../components/WeatherStrip.jsx'
import { fetchDailyUsage, fetchDaySim, ymd, parseYmd, addDays } from '../api/client.js'
import { COLORS, DEVICE_COLORS, BATTERY, SLOTS_PER_DAY, slotToTime } from '../lib/constants.js'
import { TIER_LABEL, isSummer } from '../lib/tou.js'
import { nowTaipei } from '../lib/time.js'
import { useTheme, getTheme, setTheme } from '../lib/theme.js'
import { toCsv, downloadCsv, printReport } from '../lib/exportFile.js'
import { dayRecord, GRID_CO2_SOURCE, GRID_CO2_KG_PER_KWH } from '../lib/dayRecord.js'
import {
  baseTooltip,
  baseLegend,
  baseGrid,
  slotXAxis,
  valueYAxis,
  peakMarkArea,
  AXIS_TEXT,
  SPLIT_LINE,
} from '../lib/charts.js'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const weekdayOf = (s) => WEEK[parseYmd(s).getDay()]

// 列印時白紙上要看得清楚：夜間模式先切到日間，印完再切回來（不寫入使用者的偏好）
function printInLight() {
  const prev = getTheme()
  printReport(
    () => prev === 'dark' && setTheme('light', { remember: false }),
    () => prev === 'dark' && setTheme('dark', { remember: false })
  )
}

export default function History() {
  const yesterday = useMemo(() => addDays(nowTaipei(), -1), [])
  const minDay = useMemo(() => addDays(yesterday, -364), [yesterday]) // 往回最多一年
  const [tab, setTab] = useState('day')
  const [day, setDay] = useState(() => ymd(yesterday))

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
      {tab === 'day' ? (
        <DayView date={day} setDate={setDay} yesterday={yesterday} minDay={minDay} />
      ) : (
        <RangeView
          yesterday={yesterday}
          minDay={minDay}
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

  useEffect(() => {
    let on = true
    setRes(null)
    fetchDaySim(date).then((r) => on && setRes(r))
    return () => { on = false }
  }, [date])

  const sim = res?.sim
  const rec = useMemo(() => (sim ? dayRecord(sim) : null), [sim])
  const s = rec?.summary

  const step = (n) => {
    const t = addDays(parseYmd(date), n)
    if (t < minDay || t > yesterday) return
    setDate(ymd(t))
  }
  const atFirst = date <= ymd(minDay)
  const atLast = date >= ymd(yesterday)

  /* ---- 當天的即時運轉曲線（整天） ---- */
  const curveOption = useMemo(() => {
    if (!sim) return {}
    const line = { type: 'line', smooth: true, symbol: 'none' }
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps.map((p) => `${p.marker}${p.seriesName}: ${p.seriesName === 'SOC' ? Math.round(p.value) + '%' : (+p.value).toFixed(2) + ' kW'}`).join('<br/>'),
      },
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      grid: { ...baseGrid, right: 48 },
      xAxis: slotXAxis({ boundaryGap: true }),
      yAxis: [
        valueYAxis('kW'),
        {
          type: 'value', name: 'SOC %', min: 0, max: 100, position: 'right',
          nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
          axisLine: { show: false }, splitLine: { show: false },
        },
      ],
      series: [
        { ...line, name: '太陽能發電', data: sim.pv, lineStyle: { width: 2, color: COLORS.solar }, itemStyle: { color: COLORS.solar }, areaStyle: { color: 'rgba(255,176,32,0.16)' }, markArea: peakMarkArea(sim.tier) },
        { ...line, name: '家庭負載', data: sim.load, lineStyle: { width: 2, color: COLORS.load }, itemStyle: { color: COLORS.load } },
        { ...line, name: '電網購電', data: sim.gridKw, lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' }, itemStyle: { color: COLORS.grid } },
        { type: 'bar', stack: 'b', name: '電池充電', data: sim.chargeKw, itemStyle: { color: 'rgba(34,197,94,0.55)' } },
        { type: 'bar', stack: 'b', name: '電池放電', data: sim.dischargeKw.map((v) => -v), itemStyle: { color: 'rgba(249,115,22,0.6)' } },
        { ...line, name: 'SOC', yAxisIndex: 1, data: sim.socPct, lineStyle: { width: 2.4, color: COLORS.battery }, itemStyle: { color: COLORS.battery } },
      ],
    }
  }, [sim, theme])

  /* ---- 各設備用電排行 ---- */
  const deviceOption = useMemo(() => {
    if (!rec) return {}
    const list = [...rec.devices].reverse() // 橫條圖由下往上畫，反過來才會是「最多的在最上面」
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
  }, [rec, theme])

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
  const nonGridPct = rec && rec.load > 0 ? ((rec.load - rec.sources[2].kwh) / rec.load) * 100 : 0

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
            <button className="btn" onClick={() => step(-1)} disabled={atFirst} aria-label="前一天">◀</button>
            <input type="date" className="date-input" value={date} min={ymd(minDay)} max={ymd(yesterday)} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <button className="btn" onClick={() => step(1)} disabled={atLast} aria-label="後一天">▶</button>
            <strong className="day-nav-wd">週{weekdayOf(date)}</strong>
            {w && (
              <span className="day-nav-wx">
                <span className="wx-icon">{w.icon}</span>
                {w.label}・{w.tempMin.toFixed(0)}～{w.tempMax.toFixed(0)}°C・降雨機率最高 {w.popMax}%
              </span>
            )}
          </div>
          <div className="export-btns">
            <button className="btn" onClick={exportDay} disabled={!sim}>⬇ 匯出當日明細</button>
            <button className="btn" onClick={printInLight}>🖨 列印／PDF</button>
          </div>
        </div>
      </Panel>

      {!rec ? (
        <div className="skeleton mt-16" style={{ height: 420 }} />
      ) : (
        <>
          {/* 省下多少錢 */}
          <div className="grid cols-6 mt-16">
            <Tile label="當日電費" value={s.optimizedCost.toFixed(1)} unit="元" sub={`向電網購電 ${rec.gridBought.toFixed(1)} 度`} />
            <Tile label="不裝 HEMS 的電費" value={s.baselineCost.toFixed(1)} unit="元" sub="無太陽能、無電池，全部向台電購買" />
            <Tile label="省下電費" value={s.savings.toFixed(1)} unit="元" sub={`省 ${s.savingPct}%`} color={COLORS.save} />
            <Tile label="用電" value={rec.load.toFixed(1)} unit="kWh" sub="家庭總負載" color={COLORS.load} />
            <Tile label="太陽能發電" value={rec.pv.toFixed(1)} unit="kWh" sub={`自用率 ${s.selfUseRate}%`} color={COLORS.solar} />
            <Tile label="減碳" value={rec.co2Kg.toFixed(1)} unit="kg CO₂" sub={`少向電網買 ${rec.avoidedKwh.toFixed(1)} 度`} color={COLORS.battery} />
          </div>

          {/* 即時運轉曲線 */}
          <Panel
            title="當日即時運轉曲線"
            sub="太陽能・家庭負載・電網購電・電池充放電・SOC（右軸）；紅底為尖峰時段"
            className="mt-16"
            right={<span className="badge">🧪 模擬紀錄</span>}
          >
            <WeatherStrip weather={sim.weather} />
            <EChart option={curveOption} height={300} />
          </Panel>

          <div className="grid cols-2 mt-16">
            {/* 電費拆解 */}
            <Panel title="電費拆解" sub={`台電簡易二段式・${isSummer(parseYmd(date)) ? '夏月' : '非夏月'}`}>
              <div className="table-wrap">
                <table className="history-table compact">
                  <thead>
                    <tr>
                      <th>時段</th>
                      <th className="num">電價</th>
                      <th className="num">裝 HEMS</th>
                      <th className="num">不裝 HEMS</th>
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
                            <span className="dim">（{(t.slots / 4).toFixed(1).replace(/\.0$/, '')} 小時）</span>
                          </td>
                          <td className="num">{t.price.toFixed(2)} 元/度</td>
                          <td className="num">{t.hemsKwh.toFixed(1)} 度<br /><strong>{t.hemsCost.toFixed(1)} 元</strong></td>
                          <td className="num dim">{t.baseKwh.toFixed(1)} 度<br />{t.baseCost.toFixed(1)} 元</td>
                          <td className={`num ${diff >= 0 ? 'save' : 'more'}`}>
                            {diff >= 0 ? `省 ${diff.toFixed(1)}` : `多 ${(-diff).toFixed(1)}`} 元
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
                      <td className="num save">省 {s.savings.toFixed(1)} 元</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="hint prose mt-16">
                錢主要是從<strong>尖峰</strong>省下來的：白天的太陽能先存進電池，傍晚尖峰改用電池供電，
                少向台電買最貴的電。離峰若出現「多」，是半夜趁便宜先充電池，換掉尖峰的昂貴購電。
              </p>
            </Panel>

            {/* 能源來源與去向 */}
            <Panel title="能源來源與去向" sub="家裡的電從哪來、太陽能的電去了哪">
              <StackBar title="家庭用電" total={rec.load} parts={rec.sources} colors={{ pv: COLORS.solar, batt: COLORS.battery, grid: COLORS.grid }} />
              <StackBar title="太陽能發電" total={rec.pv} parts={rec.pvDest} colors={{ self: COLORS.solar, batt: COLORS.battery, cut: '#94a3b8' }} />
              <p className="hint prose">
                非電網供應比例 {nonGridPct.toFixed(1)}%。
                「削減」是本系統設定防逆送，太陽能發多了又充不進電池時，不能賣回台電而被捨棄的部分。
              </p>
            </Panel>
          </div>

          <div className="grid cols-2 mt-16">
            {/* 設備用電排行 */}
            <Panel title="各設備用電排行" sub="當日用電量（kWh）">
              <EChart option={deviceOption} height={Math.max(220, rec.devices.length * 28)} />
            </Panel>

            {/* 可轉移設備的排程 */}
            <Panel title="可轉移設備運轉時段" sub="排程把這些設備安排在哪幾點運轉">
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
          <Panel title="電池" sub={`Tesla Powerwall 2・${BATTERY.capacityKwh} kWh・SOC ${BATTERY.socMin * 100}～${BATTERY.socMax * 100}%`} className="mt-16">
            <div className="grid cols-6">
              <Tile label="充電" value={rec.battery.chargeKwh.toFixed(2)} unit="kWh" color={COLORS.battery} />
              <Tile label="其中太陽能充電" value={rec.battery.fromPvKwh.toFixed(2)} unit="kWh" sub={`電網充電 ${rec.battery.fromGridKwh.toFixed(2)} kWh`} color={COLORS.solar} />
              <Tile label="放電" value={rec.battery.dischargeKwh.toFixed(2)} unit="kWh" color="#f97316" />
              <Tile label="等效循環" value={rec.battery.cycles.toFixed(2)} unit="次" sub="放電量 ÷ 可用容量" />
              <Tile label="SOC 最高" value={rec.battery.socMax.toFixed(0)} unit="%" sub={rec.battery.socMaxAt} />
              <Tile label="SOC 最低" value={rec.battery.socMin.toFixed(0)} unit="%" sub={rec.battery.socMinAt} />
            </div>
          </Panel>

          <p className="hint prose mt-16">
            🧪 系統尚未接上實際電表，以上是依當日天氣與台電簡易二段式電價模擬的運轉紀錄；
            不可轉移負載採用資料集（UCI household_power_consumption）{res.profileFrom ? ` ${res.profileFrom}（同為週${weekdayOf(date)}）` : ''}的實測曲線。
            減碳量以{GRID_CO2_SOURCE}（{GRID_CO2_KG_PER_KWH} 公斤 CO₂e／度）乘上少向電網購買的度數計算。
          </p>
        </>
      )}
    </>
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
    // 區間頭尾可能只涵蓋半週，標籤寫實際涵蓋的日期，不寫整週
    label:
      unit === 'week'
        ? `${g.first.slice(5).replace('-', '/')} ～ ${g.last.slice(5).replace('-', '/')}`
        : `${g.key.slice(0, 4)} 年 ${Number(g.key.slice(5))} 月`,
  }))
}
const total = (rows) => Object.fromEntries(FIELDS.map((f) => [f, rows.reduce((a, r) => a + r[f], 0)]))

function RangeView({ yesterday, minDay, onPickDay }) {
  const theme = useTheme()
  const [from, setFrom] = useState(() => {
    // 預設「昨天所在的那個月，從 1 號到昨天」。
    // 今天是 1 號時昨天屬於上個月，就會自然顯示整個上月，不會出現空區間
    return ymd(new Date(yesterday.getFullYear(), yesterday.getMonth(), 1))
  })
  const [to, setTo] = useState(() => ymd(yesterday))
  const [unit, setUnit] = useState('day')
  const [data, setData] = useState(null)

  useEffect(() => {
    let on = true
    const [a, b] = from <= to ? [from, to] : [to, from] // 起訖選反了就自動對調
    fetchDailyUsage(a, b).then((d) => on && setData(d))
    return () => { on = false }
  }, [from, to])

  const rows = data?.rows ?? []
  const groups = useMemo(() => groupRows(rows, unit), [rows, unit])
  const sum = useMemo(() => total(rows), [rows])

  const quick = (kind) => {
    const y = yesterday
    const set = (a, b) => { setFrom(ymd(a < minDay ? minDay : a)); setTo(ymd(b)) }
    if (kind === 'thisMonth') set(new Date(y.getFullYear(), y.getMonth(), 1), y)
    if (kind === 'lastMonth') set(new Date(y.getFullYear(), y.getMonth() - 1, 1), new Date(y.getFullYear(), y.getMonth(), 0))
    if (kind === '7') set(addDays(y, -6), y)
    if (kind === '30') set(addDays(y, -29), y)
    if (kind === 'year') { set(addDays(y, -364), y); setUnit('month') }
  }

  const chartOption = useMemo(() => {
    if (!groups.length) return {}
    const dense = groups.length > 45 // 長條太多時拿掉間距，不然擠成一片
    const bar = { type: 'bar', barGap: dense ? '0%' : '15%', barCategoryGap: dense ? '10%' : '30%' }
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps.map((p) => `${p.marker}${p.seriesName}: ${(+p.value).toFixed(p.seriesName.includes('元') ? 1 : 2)} ${p.seriesName.includes('元') ? '元' : 'kWh'}`).join('<br/>'),
      },
      legend: { ...baseLegend, data: ['用電（kWh）', '太陽能發電（kWh）', '向電網購電（kWh）', '電費（元）'] },
      grid: { ...baseGrid, right: 52, bottom: 44 },
      xAxis: {
        type: 'category',
        data: groups.map((g) => g.label),
        axisLine: { lineStyle: { color: SPLIT_LINE } },
        axisTick: { show: false },
        axisLabel: { color: AXIS_TEXT, fontSize: 11, hideOverlap: true },
      },
      yAxis: [
        { type: 'value', name: 'kWh', nameTextStyle: { color: AXIS_TEXT, fontSize: 11 }, axisLabel: { color: AXIS_TEXT, fontSize: 11 }, splitLine: { lineStyle: { color: SPLIT_LINE } } },
        { type: 'value', name: '元', position: 'right', nameTextStyle: { color: AXIS_TEXT, fontSize: 11 }, axisLabel: { color: AXIS_TEXT, fontSize: 11 }, splitLine: { show: false } },
      ],
      series: [
        { ...bar, name: '用電（kWh）', data: groups.map((g) => +g.loadKwh.toFixed(2)), itemStyle: { color: COLORS.load, borderRadius: [3, 3, 0, 0] } },
        { ...bar, name: '太陽能發電（kWh）', data: groups.map((g) => +g.pvKwh.toFixed(2)), itemStyle: { color: COLORS.solar, borderRadius: [3, 3, 0, 0] } },
        { ...bar, name: '向電網購電（kWh）', data: groups.map((g) => +g.gridKwh.toFixed(2)), itemStyle: { color: COLORS.grid, borderRadius: [3, 3, 0, 0] } },
        {
          type: 'line', name: '電費（元）', yAxisIndex: 1, smooth: true, symbol: dense ? 'none' : 'circle', symbolSize: 6,
          data: groups.map((g) => +g.cost.toFixed(1)), lineStyle: { width: 2.2, color: COLORS.save }, itemStyle: { color: COLORS.save },
        },
      ],
    }
  }, [groups, theme])

  const [a, b] = from <= to ? [from, to] : [to, from]
  const COLS = (first) => [
    { key: 'label', label: first },
    { key: 'loadKwh', label: '用電(kWh)', digits: 2 },
    { key: 'pvKwh', label: '太陽能發電(kWh)', digits: 2 },
    { key: 'gridKwh', label: '向電網購電(kWh)', digits: 2 },
    { key: 'dischargeKwh', label: '電池放電(kWh)', digits: 2 },
    { key: 'cost', label: '電費(元)', digits: 1 },
    { key: 'baseline', label: '不裝HEMS電費(元)', digits: 1 },
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
  const savePct = sum.baseline > 0 ? (sum.savings / sum.baseline) * 100 : 0

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
              <input type="date" className="date-input" value={from} min={ymd(minDay)} max={ymd(yesterday)} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </label>
            <span className="dim">～</span>
            <label className="field">
              <span>結束</span>
              <input type="date" className="date-input" value={to} min={ymd(minDay)} max={ymd(yesterday)} onChange={(e) => e.target.value && setTo(e.target.value)} />
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
        <div className="quick-ranges">
          <span className="dim">快速選擇：</span>
          <button onClick={() => quick('thisMonth')}>本月</button>
          <button onClick={() => quick('lastMonth')}>上個月</button>
          <button onClick={() => quick('7')}>近 7 天</button>
          <button onClick={() => quick('30')}>近 30 天</button>
          <button onClick={() => quick('year')}>近 12 個月</button>
          <span className="dim" style={{ marginLeft: 'auto' }}>只列到昨天：今天要到 24:00 才結算</span>
        </div>
      </Panel>

      {!data ? (
        <div className="skeleton mt-16" style={{ height: 320 }} />
      ) : (
        <>
          <div className="grid cols-6 mt-16">
            <Tile label="區間用電" value={sum.loadKwh.toFixed(1)} unit="kWh" sub={`${rows.length} 天，日均 ${(sum.loadKwh / rows.length).toFixed(1)} kWh`} color={COLORS.load} />
            <Tile label="太陽能發電" value={sum.pvKwh.toFixed(1)} unit="kWh" color={COLORS.solar} />
            <Tile label="向電網購電" value={sum.gridKwh.toFixed(1)} unit="kWh" color={COLORS.grid} />
            <Tile label="電費" value={Math.round(sum.cost).toLocaleString()} unit="元" sub={`日均 ${(sum.cost / rows.length).toFixed(1)} 元`} />
            <Tile label="不裝 HEMS 的電費" value={Math.round(sum.baseline).toLocaleString()} unit="元" sub="無太陽能、無電池，全部向台電購買" />
            <Tile label="省下電費" value={Math.round(sum.savings).toLocaleString()} unit="元" sub={`省 ${savePct.toFixed(1)}%`} color={COLORS.save} />
          </div>

          <Panel title={`用電與電費（依${unitLabel}）`} sub={`${a} ～ ${b}`} className="mt-16" right={<span className="badge">🧪 模擬紀錄</span>}>
            <EChart option={chartOption} height={300} />
          </Panel>

          <Panel title={`用電明細（依${unitLabel}）`} sub={unit === 'day' ? `共 ${groups.length} 筆・點任一天看當日完整紀錄` : `共 ${groups.length} 筆`} className="mt-16">
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
                    <th className="num">不裝 HEMS</th>
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
                    >
                      <td>{g.label}</td>
                      {unit !== 'day' && <td className="num">{g.days}</td>}
                      <td className="num">{g.loadKwh.toFixed(2)}</td>
                      <td className="num">{g.pvKwh.toFixed(2)}</td>
                      <td className="num">{g.gridKwh.toFixed(2)}</td>
                      <td className="num">{g.cost.toFixed(1)} 元</td>
                      <td className="num dim">{g.baseline.toFixed(1)} 元</td>
                      <td className="num save">{g.savings.toFixed(1)} 元</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>合計</td>
                    {unit !== 'day' && <td className="num">{rows.length}</td>}
                    <td className="num">{sum.loadKwh.toFixed(2)}</td>
                    <td className="num">{sum.pvKwh.toFixed(2)}</td>
                    <td className="num">{sum.gridKwh.toFixed(2)}</td>
                    <td className="num">{sum.cost.toFixed(1)} 元</td>
                    <td className="num">{sum.baseline.toFixed(1)} 元</td>
                    <td className="num save">{sum.savings.toFixed(1)} 元</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="hint prose mt-16">
              🧪 系統尚未接上實際電表，以上是依各日天氣與台電簡易二段式電價（夏月／非夏月、平日／假日）
              逐日模擬的運轉紀錄；不可轉移負載採用資料集（UCI household_power_consumption）中同一個星期幾的實測曲線，
              因此同一個星期幾的用電量每週相同。
              {unit === 'day' && ' 週末列以底色標示：週末全天離峰、沒有尖離峰價差，電池能省的錢明顯較少。'}
            </p>
          </Panel>
        </>
      )}
    </>
  )
}
