/* ============================================================
   頁面四：歷史紀錄查詢與報表匯出

   資料分兩種，畫面上刻意分開標示：
   - 不可轉移負載的「真實值」與「預測」：來自 MongoDB 的實際紀錄
   - HEMS 運轉（太陽能、電池、電網、電費）：拿那天的真實負載餵模擬引擎算出來的，
     因為太陽能與排程目前仍是模擬；代表「那天若由本系統運轉會怎樣」，不是量測值

   預測放了兩條：日前（前一晚 23:45 發布，排程時手上有的）與一步（只往前看 15 分鐘）。
   兩者是預測距離的兩端，並排才看得出「越近越準」實際差多少。
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import { fetchHistory, simulateHistoryDay } from '../api/client.js'
import { COLORS, slotToTime } from '../lib/constants.js'
import { useTheme, getTheme, setTheme } from '../lib/theme.js'
import { mae, rmse, mape, energyKwh, peak } from '../lib/metrics.js'
import { TIER_LABEL } from '../lib/tou.js'
import { toCsv, downloadCsv, printReport } from '../lib/exportFile.js'
import {
  baseTooltip,
  baseLegend,
  baseGrid,
  slotXAxis,
  valueYAxis,
  peakMarkArea,
  AXIS_TEXT,
  TEXT_MAIN,
} from '../lib/charts.js'

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const weekdayOf = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  return WEEK[new Date(y, m - 1, d).getDay()]
}

/** 一天的完整紀錄：預測指標 + 模擬運轉結果 */
function buildDay(day) {
  const sim = simulateHistoryDay(day.date, day.actual)
  const pk = peak(day.actual)
  return {
    ...day,
    weekday: weekdayOf(day.date),
    sim,
    kwh: energyKwh(day.actual),
    peakKw: pk.kw,
    peakAt: slotToTime(pk.slot),
    daMae: mae(day.day_ahead, day.actual),
    daRmse: rmse(day.day_ahead, day.actual),
    daMape: mape(day.day_ahead, day.actual),
    osMae: mae(day.one_step, day.actual),
  }
}

export default function History() {
  const theme = useTheme()
  const [hist, setHist] = useState(undefined) // undefined = 載入中、null = 讀取失敗
  const [sel, setSel] = useState(null)

  useEffect(() => {
    fetchHistory().then((h) => {
      setHist(h)
      if (h?.days?.length) setSel(h.days[h.days.length - 1].date) // 預設看最新一天
    })
  }, [])

  // 七天全部先算好：總覽表要用，切換日期時也不必重算
  const days = useMemo(() => (hist?.days ?? []).map(buildDay), [hist])
  const day = days.find((d) => d.date === sel) ?? null

  /* ---------------- 圖：真實 vs 預測 ---------------- */
  const loadOption = useMemo(() => {
    if (!day) return {}
    const line = { type: 'line', smooth: true, symbol: 'none' }
    return {
      tooltip: { ...baseTooltip, valueFormatter: (v) => `${(+v).toFixed(3)} kW` },
      legend: { ...baseLegend, data: ['真實值', '日前預測', '一步預測'] },
      grid: { ...baseGrid, right: 24 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW', { min: 0 }),
      series: [
        { ...line, name: '真實值', data: day.actual, lineStyle: { width: 2.2, color: TEXT_MAIN }, itemStyle: { color: TEXT_MAIN } },
        { ...line, name: '日前預測', data: day.day_ahead, lineStyle: { width: 2, color: COLORS.load, type: 'dashed' }, itemStyle: { color: COLORS.load } },
        { ...line, name: '一步預測', data: day.one_step, lineStyle: { width: 1.4, color: COLORS.save }, itemStyle: { color: COLORS.save } },
      ],
    }
  }, [day, theme])

  /* ---------------- 圖：HEMS 運轉（模擬） ---------------- */
  const hemsOption = useMemo(() => {
    if (!day) return {}
    const s = day.sim
    const line = { type: 'line', smooth: true, symbol: 'none' }
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .map((p) => `${p.marker}${p.seriesName}: ${p.seriesName === 'SOC' ? Math.round(p.value) + '%' : (+p.value).toFixed(2) + ' kW'}`)
            .join('<br/>'),
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
        { ...line, name: '太陽能發電', data: s.pv, lineStyle: { width: 2, color: COLORS.solar }, itemStyle: { color: COLORS.solar }, areaStyle: { color: 'rgba(255,176,32,0.16)' }, markArea: peakMarkArea(s.tier) },
        { ...line, name: '家庭負載', data: s.load, lineStyle: { width: 2, color: COLORS.load }, itemStyle: { color: COLORS.load } },
        { ...line, name: '電網購電', data: s.gridKw, lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' }, itemStyle: { color: COLORS.grid } },
        { type: 'bar', stack: 'b', name: '電池充電', data: s.chargeKw, itemStyle: { color: 'rgba(34,197,94,0.55)' } },
        { type: 'bar', stack: 'b', name: '電池放電', data: s.dischargeKw.map((v) => -v), itemStyle: { color: 'rgba(249,115,22,0.6)' } },
        { ...line, name: 'SOC', yAxisIndex: 1, data: s.socPct, lineStyle: { width: 2.4, color: COLORS.battery }, itemStyle: { color: COLORS.battery } },
      ],
    }
  }, [day, theme])

  /* ---------------- 匯出 ---------------- */
  const exportDay = () => {
    if (!day) return
    const s = day.sim
    const rows = day.actual.map((a, i) => ({
      time: `${day.date} ${slotToTime(i)}`,
      actual: a,
      dayAhead: day.day_ahead[i],
      oneStep: day.one_step[i],
      err: day.day_ahead[i] - a,
      pv: s.pv[i],
      load: s.load[i],
      grid: s.gridKw[i],
      charge: s.chargeKw[i],
      discharge: s.dischargeKw[i],
      soc: s.socPct[i],
      tier: TIER_LABEL[s.tier[i]] ?? s.tier[i],
    }))
    downloadCsv(
      `HEMS_歷史紀錄_${day.date}.csv`,
      toCsv(rows, [
        { key: 'time', label: '時間' },
        { key: 'actual', label: '不可轉移負載_真實(kW)', digits: 4 },
        { key: 'dayAhead', label: '不可轉移負載_日前預測(kW)', digits: 4 },
        { key: 'oneStep', label: '不可轉移負載_一步預測(kW)', digits: 4 },
        { key: 'err', label: '日前預測誤差(kW)', digits: 4 },
        { key: 'pv', label: '太陽能發電_模擬(kW)', digits: 3 },
        { key: 'load', label: '家庭總負載_模擬(kW)', digits: 3 },
        { key: 'grid', label: '電網購電_模擬(kW)', digits: 3 },
        { key: 'charge', label: '電池充電_模擬(kW)', digits: 3 },
        { key: 'discharge', label: '電池放電_模擬(kW)', digits: 3 },
        { key: 'soc', label: 'SOC_模擬(%)', digits: 1 },
        { key: 'tier', label: '電價時段' },
      ])
    )
  }

  const exportSummary = () => {
    if (!days.length) return
    const rows = days.map((d) => ({
      date: d.date,
      weekday: `週${d.weekday}`,
      kwh: d.kwh,
      peak: d.peakKw,
      peakAt: d.peakAt,
      daMae: d.daMae,
      daRmse: d.daRmse,
      daMape: d.daMape,
      osMae: d.osMae,
      cost: d.sim.summary.optimizedCost,
      saving: d.sim.summary.savings,
      pv: d.sim.summary.pvKwh,
      grid: d.sim.summary.gridImportKwh,
    }))
    downloadCsv(
      `HEMS_七日摘要_${days[0].date}_${days[days.length - 1].date}.csv`,
      toCsv(rows, [
        { key: 'date', label: '日期' },
        { key: 'weekday', label: '星期' },
        { key: 'kwh', label: '不可轉移負載用電(kWh)', digits: 2 },
        { key: 'peak', label: '尖峰負載(kW)', digits: 3 },
        { key: 'peakAt', label: '尖峰時刻' },
        { key: 'daMae', label: '日前預測MAE(kW)', digits: 4 },
        { key: 'daRmse', label: '日前預測RMSE(kW)', digits: 4 },
        { key: 'daMape', label: '日前預測MAPE(%)', digits: 1 },
        { key: 'osMae', label: '一步預測MAE(kW)', digits: 4 },
        { key: 'pv', label: '太陽能發電_模擬(kWh)', digits: 2 },
        { key: 'grid', label: '電網購電_模擬(kWh)', digits: 2 },
        { key: 'cost', label: '電費_模擬(元)', digits: 1 },
        { key: 'saving', label: '省電費_模擬(元)', digits: 1 },
      ])
    )
  }

  // 列印時白紙上要看得清楚：夜間模式先切到日間，印完再切回來（不寫入使用者的偏好）
  const exportPdf = () => {
    const prev = getTheme()
    printReport(
      () => prev === 'dark' && setTheme('light', { remember: false }),
      () => prev === 'dark' && setTheme('dark', { remember: false })
    )
  }

  /* ---------------- 畫面 ---------------- */
  if (hist === undefined) return <div className="skeleton" style={{ height: 320 }} />
  if (!hist || !days.length) {
    return (
      <Panel title="歷史紀錄">
        <p className="hint">讀不到歷史資料（public/data/history.json）。請先在 負載預測2 執行 mongo_handoff/04_export_web.py。</p>
      </Panel>
    )
  }

  const avg = (k) => days.reduce((a, d) => a + (d[k] ?? 0), 0) / days.length
  const sum = (f) => days.reduce((a, d) => a + f(d), 0)
  const improve = day?.daMae ? (1 - day.osMae / day.daMae) * 100 : null

  return (
    <div className="history">
      {/* 列印時才出現的報表抬頭 */}
      <div className="print-only report-head">
        <h1>家庭能源管理系統　歷史紀錄報表</h1>
        <p>
          查詢日期 {day?.date}（週{day?.weekday}）・資料區間 {days[0].date} ～ {days[days.length - 1].date}
          ・資料來源 {hist.source}・匯出於 {new Date().toLocaleString('zh-TW', { hour12: false })}
        </p>
      </div>

      {/* 控制列：選日期 + 匯出 */}
      <Panel className="no-print">
        <div className="history-bar">
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              查詢日期（資料集：法國 Sceaux 住宅，UCI household_power_consumption）
            </div>
            <div className="day-chips">
              {days.map((d) => (
                <button
                  key={d.date}
                  className={`day-chip ${d.date === sel ? 'active' : ''}`}
                  onClick={() => setSel(d.date)}
                >
                  <strong>{d.date.slice(5).replace('-', '/')}</strong>
                  <span>週{d.weekday}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="export-btns">
            <button className="btn" onClick={exportDay} title="該日 96 格（15 分鐘）明細">⬇ 當日明細 CSV</button>
            <button className="btn" onClick={exportSummary} title="七天各一列的摘要">⬇ 七日摘要 CSV</button>
            <button className="btn" onClick={exportPdf} title="用瀏覽器列印，可選「另存為 PDF」">🖨 列印／另存 PDF</button>
          </div>
        </div>
      </Panel>

      {day && (
        <>
          {/* 預測表現 */}
          <div className="grid cols-6 mt-16">
            <Tile label="當日用電" value={day.kwh.toFixed(2)} unit="kWh" sub="不可轉移負載・真實值" color={COLORS.load} />
            <Tile label="尖峰負載" value={day.peakKw.toFixed(2)} unit="kW" sub={`發生於 ${day.peakAt}`} />
            <Tile label="日前預測 MAE" value={day.daMae.toFixed(3)} unit="kW" sub={`RMSE ${day.daRmse.toFixed(3)} kW`} />
            <Tile label="日前預測 MAPE" value={day.daMape.toFixed(1)} unit="%" sub="排除真實值 < 0.05 kW 的格子" />
            <Tile label="一步預測 MAE" value={day.osMae.toFixed(3)} unit="kW" sub="只往前看 15 分鐘" color={COLORS.save} />
            <Tile
              label="預測越近越準"
              value={improve == null ? '—' : improve.toFixed(0)}
              unit="%"
              sub="一步比日前的 MAE 降低幅度"
              color={COLORS.save}
            />
          </div>

          <Panel
            title="不可轉移負載：真實 vs 預測"
            sub={`日前預測於 ${day.day_ahead_refresh} 發布（提前一整天，排程時手上有的）；一步預測每格都取前一格發布、只看 15 分鐘後的值`}
            className="mt-16"
            right={<span className="badge">MongoDB 實際紀錄</span>}
          >
            <EChart option={loadOption} height={280} />
          </Panel>

          <Panel
            title="HEMS 運轉紀錄"
            sub="以當日真實負載餵入模擬引擎：太陽能與排程目前仍為模擬，代表「那天若由本系統運轉」的結果，不是量測值"
            className="mt-16"
            right={<span className="badge">🧪 模擬</span>}
          >
            <div className="grid cols-6" style={{ marginBottom: 12 }}>
              <Tile label="太陽能發電" value={day.sim.summary.pvKwh} unit="kWh" color={COLORS.solar} />
              <Tile label="向電網購電" value={day.sim.summary.gridImportKwh} unit="kWh" color={COLORS.grid} />
              <Tile label="電池放電" value={day.sim.summary.dischargeKwh} unit="kWh" color={COLORS.battery} />
              <Tile label="太陽能自用率" value={day.sim.summary.selfUseRate} unit="%" color={COLORS.battery} />
              <Tile label="電費" value={day.sim.summary.optimizedCost} unit="元" sub={`不裝 HEMS：${day.sim.summary.baselineCost} 元`} />
              <Tile label="省下電費" value={day.sim.summary.savings} unit="元" sub={`省 ${day.sim.summary.savingPct}%`} color={COLORS.save} />
            </div>
            <EChart option={hemsOption} height={280} />
          </Panel>
        </>
      )}

      {/* 七日總覽 */}
      <Panel
        title="七日總覽"
        sub="點選任一列可切換到該日"
        className="mt-16"
      >
        <div className="table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>星期</th>
                <th className="num">用電 kWh</th>
                <th className="num">尖峰 kW</th>
                <th className="num">日前 MAE</th>
                <th className="num">日前 MAPE</th>
                <th className="num">一步 MAE</th>
                <th className="num">電費（模擬）</th>
                <th className="num">省電費（模擬）</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr
                  key={d.date}
                  className={d.date === sel ? 'active' : ''}
                  onClick={() => setSel(d.date)}
                >
                  <td>{d.date}</td>
                  <td>週{d.weekday}</td>
                  <td className="num">{d.kwh.toFixed(2)}</td>
                  <td className="num">{d.peakKw.toFixed(2)} <span className="dim">@{d.peakAt}</span></td>
                  <td className="num">{d.daMae.toFixed(3)}</td>
                  <td className="num">{d.daMape.toFixed(1)}%</td>
                  <td className="num">{d.osMae.toFixed(3)}</td>
                  <td className="num">{d.sim.summary.optimizedCost.toFixed(1)} 元</td>
                  <td className="num save">{d.sim.summary.savings.toFixed(1)} 元</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>七日{' '}合計／平均</td>
                <td className="num">{sum((d) => d.kwh).toFixed(2)}</td>
                <td className="num">{Math.max(...days.map((d) => d.peakKw)).toFixed(2)}</td>
                <td className="num">{avg('daMae').toFixed(3)}</td>
                <td className="num">{avg('daMape').toFixed(1)}%</td>
                <td className="num">{avg('osMae').toFixed(3)}</td>
                <td className="num">{sum((d) => d.sim.summary.optimizedCost).toFixed(1)} 元</td>
                <td className="num save">{sum((d) => d.sim.summary.savings).toFixed(1)} 元</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="hint mt-16">
          用電、尖峰與預測誤差為 MongoDB 的實際紀錄；電費與省電費由模擬引擎以當日真實負載計算（台電簡易二段式時間電價）。
        </p>
      </Panel>
    </div>
  )
}
