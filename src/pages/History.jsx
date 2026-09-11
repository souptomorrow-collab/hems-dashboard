/* ============================================================
   頁面四：歷史紀錄（用電紀錄，電費帳單式）

   選一段日期區間，依「日／週／月」彙整：用電、太陽能發電、向電網購電、
   電費，以及和「不裝 HEMS」相比省下多少。可匯出日報、月報，或列印成 PDF。

   資料來源見 api/client.js 的 fetchDailyUsage()：系統尚未接實際電表，
   每一天是用同一套模擬引擎依當日天氣與電價重跑出來的紀錄，畫面上會標明。
   只收「已經結束」的日子（到昨天為止）——和電費帳單一樣，今天還在跑，
   要到 24:00 才結算。
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import { fetchDailyUsage, ymd, parseYmd, addDays } from '../api/client.js'
import { COLORS } from '../lib/constants.js'
import { nowTaipei } from '../lib/time.js'
import { useTheme, getTheme, setTheme } from '../lib/theme.js'
import { toCsv, downloadCsv, printReport } from '../lib/exportFile.js'
import { baseTooltip, baseLegend, baseGrid, AXIS_TEXT, SPLIT_LINE } from '../lib/charts.js'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const UNITS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '週' },
  { key: 'month', label: '月' },
]
const FIELDS = ['loadKwh', 'pvKwh', 'gridKwh', 'dischargeKwh', 'cost', 'baseline', 'savings']

/* ---------------- 彙整：日 → 週／月 ---------------- */
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

export default function History() {
  const theme = useTheme()
  const yesterday = useMemo(() => addDays(nowTaipei(), -1), [])
  const minDay = useMemo(() => addDays(yesterday, -364), [yesterday]) // 往回最多一年
  const [from, setFrom] = useState(() => {
    // 預設「昨天所在的那個月，從 1 號到昨天」。
    // 今天是 1 號時昨天屬於上個月，就會自然顯示整個上月，不會出現空區間
    const first = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1)
    return ymd(first)
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

  // 快速區間
  const quick = (kind) => {
    const y = yesterday
    const set = (a, b) => { setFrom(ymd(a < minDay ? minDay : a)); setTo(ymd(b)) }
    if (kind === 'thisMonth') set(new Date(y.getFullYear(), y.getMonth(), 1), y)
    if (kind === 'lastMonth') set(new Date(y.getFullYear(), y.getMonth() - 1, 1), new Date(y.getFullYear(), y.getMonth(), 0))
    if (kind === '7') set(addDays(y, -6), y)
    if (kind === '30') set(addDays(y, -29), y)
    if (kind === 'year') { set(addDays(y, -364), y); setUnit('month') }
  }

  /* ---------------- 圖：用電／發電／購電（長條）＋ 電費（折線） ---------------- */
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
        {
          type: 'value', name: 'kWh', nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11 }, splitLine: { lineStyle: { color: SPLIT_LINE } },
        },
        {
          type: 'value', name: '元', position: 'right', nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11 }, splitLine: { show: false },
        },
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

  /* ---------------- 匯出 ---------------- */
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
  // 列印時白紙上要看得清楚：夜間模式先切到日間，印完再切回來（不寫入使用者的偏好）
  const exportPdf = () => {
    const prev = getTheme()
    printReport(
      () => prev === 'dark' && setTheme('light', { remember: false }),
      () => prev === 'dark' && setTheme('dark', { remember: false })
    )
  }

  const unitLabel = UNITS.find((u) => u.key === unit).label
  const savePct = sum.baseline > 0 ? (sum.savings / sum.baseline) * 100 : 0

  return (
    <div className="history">
      {/* 列印時才出現的報表抬頭 */}
      <div className="print-only report-head">
        <h1>家庭能源管理系統　用電紀錄</h1>
        <p>
          區間 {a} ～ {b}（{rows.length} 天）・依{unitLabel}彙整・匯出於{' '}
          {new Date().toLocaleString('zh-TW', { hour12: false })}
        </p>
      </div>

      {/* 控制列 */}
      <Panel className="no-print">
        <div className="history-bar">
          <div className="history-filters">
            <label className="field">
              <span>開始</span>
              <input type="date" value={from} min={ymd(minDay)} max={ymd(yesterday)} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </label>
            <span className="dim">～</span>
            <label className="field">
              <span>結束</span>
              <input type="date" value={to} min={ymd(minDay)} max={ymd(yesterday)} onChange={(e) => e.target.value && setTo(e.target.value)} />
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
            <button className="btn" onClick={exportPdf} title="用瀏覽器列印，可選「另存為 PDF」">🖨 列印／PDF</button>
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

          <Panel
            title={`用電與電費（依${unitLabel}）`}
            sub={`${a} ～ ${b}`}
            className="mt-16"
            right={<span className="badge">🧪 模擬紀錄</span>}
          >
            <EChart option={chartOption} height={300} />
          </Panel>

          <Panel title={`用電明細（依${unitLabel}）`} sub={`共 ${groups.length} 筆`} className="mt-16">
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
                    <tr key={g.key} className={unit === 'day' && (g.weekday === 0 || g.weekday === 6) ? 'weekend' : ''}>
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
            <p className="hint mt-16">
              🧪 系統尚未接上實際電表，以上是依各日天氣與台電簡易二段式電價（夏月／非夏月、平日／假日）
              逐日模擬的運轉紀錄；不可轉移負載採用資料集（UCI household_power_consumption）中同一個星期幾的實測曲線。
              {unit === 'day' && ' 週末列以底色標示：週末全天離峰、沒有尖離峰價差，電池能省的錢明顯較少。'}
            </p>
          </Panel>
        </>
      )}
    </div>
  )
}
