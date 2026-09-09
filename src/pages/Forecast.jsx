/* ============================================================
   負載預測（驗證頁）

   把 RF 隨機森林的「不可轉移負載」滾動預測結果直接攤開來看：
   選一個刷新時刻 → 該時刻往後 96 步（24 小時）的預測 vs 真實值，
   以及誤差隨領先步數變化的曲線。

   真實值只用於事後比對；實際排程時 GA 只能拿 predicted。
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import { COLORS } from '../lib/constants.js'
import {
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  AXIS_TEXT,
  SPLIT_LINE,
} from '../lib/charts.js'
import {
  fetchRefreshOptions,
  fetchForecast,
  fetchActual,
  parseWall,
  SUPABASE_INFO,
} from '../api/supabase.js'
import {
  actualIndex,
  alignPredictedActual,
  metrics,
  errorByLead,
  cached,
} from '../lib/loadForecast.js'

/** "2010-11-18T06:00:00+00:00" → "11/18 06:00" */
function shortLabel(ts) {
  const w = parseWall(ts)
  return w ? `${w.m}/${w.d} ${w.time}` : '—'
}

export default function Forecast() {
  const [options, setOptions] = useState([])
  const [refresh, setRefresh] = useState(null)
  const [rows, setRows] = useState(null)
  const [actualMap, setActualMap] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ok | error
  const [errMsg, setErrMsg] = useState('')

  // 載入可選的刷新時刻（每個整點一個）
  useEffect(() => {
    let on = true
    cached('refresh-options', fetchRefreshOptions)
      .then((list) => {
        if (!on) return
        setOptions(list)
        if (!list.length) {
          setStatus('error')
          setErrMsg('雲端沒有任何預測資料（load_forecast 是空的）')
          return
        }
        // 預設選中間那天，曲線比較有看頭（不是半夜的平坦段）
        setRefresh(list[Math.floor(list.length / 2)])
      })
      .catch((e) => {
        if (!on) return
        setStatus('error')
        setErrMsg(e.message)
      })
    return () => {
      on = false
    }
  }, [])

  // 載入選定 refresh 的 96 步 + 對應區間的真實值
  useEffect(() => {
    if (!refresh) return
    let on = true
    setStatus('loading')
    cached(`forecast:${refresh}`, () => fetchForecast(refresh))
      .then(async (fRows) => {
        if (!on) return
        const first = fRows[0]?.target_time
        const last = fRows[fRows.length - 1]?.target_time
        const aRows = first && last ? await cached(`actual:${first}:${last}`, () => fetchActual(first, last)) : []
        if (!on) return
        setRows(fRows)
        setActualMap(actualIndex(aRows))
        setStatus('ok')
      })
      .catch((e) => {
        if (!on) return
        setStatus('error')
        setErrMsg(e.message)
      })
    return () => {
      on = false
    }
  }, [refresh])

  const aligned = useMemo(
    () => (rows && actualMap ? alignPredictedActual(rows, actualMap) : null),
    [rows, actualMap]
  )
  const m = useMemo(
    () => (aligned ? metrics(aligned.predicted, aligned.actual) : null),
    [aligned]
  )

  // ---- 預測 vs 真實 ----
  const compareOption = useMemo(() => {
    if (!aligned) return {}
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) => {
          const lead = aligned.leads[ps[0].dataIndex]
          return (
            `${ps[0].axisValueLabel}（領先 ${lead} 步 / ${(lead * 15 / 60).toFixed(2)} 小時）<br/>` +
            ps
              .map((p) => `${p.marker}${p.seriesName}: ${p.value == null ? '—' : (+p.value).toFixed(3)} kW`)
              .join('<br/>')
          )
        },
      },
      legend: { ...baseLegend, data: ['預測值 (RF)', '真實值'] },
      grid: baseGrid,
      xAxis: {
        type: 'category',
        data: aligned.labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: SPLIT_LINE } },
        axisTick: { show: false },
        axisLabel: { color: AXIS_TEXT, interval: 7, fontSize: 11 },
      },
      yAxis: valueYAxis('kW'),
      series: [
        {
          name: '預測值 (RF)',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: aligned.predicted,
          lineStyle: { width: 2.4, color: COLORS.load },
          itemStyle: { color: COLORS.load },
        },
        {
          name: '真實值',
          type: 'line',
          smooth: true,
          symbol: 'none',
          connectNulls: false,
          data: aligned.actual,
          lineStyle: { width: 1.8, color: AXIS_TEXT, type: 'dashed' },
          itemStyle: { color: AXIS_TEXT },
        },
      ],
    }
  }, [aligned])

  // ---- 誤差 vs 領先步數 ----
  const errorOption = useMemo(() => {
    if (!aligned) return {}
    const errs = errorByLead(aligned.leads, aligned.predicted, aligned.actual)
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) => {
          const p = ps[0]
          const hrs = (p.dataIndex + 1) * 0.25
          return `領先 ${p.dataIndex + 1} 步（${hrs.toFixed(2)} 小時後）<br/>${p.marker}絕對誤差: ${
            p.value == null ? '—' : (+p.value).toFixed(3)
          } kW`
        },
      },
      grid: { ...baseGrid, top: 24 },
      xAxis: {
        type: 'category',
        data: errs.map((e) => e.lead),
        boundaryGap: false,
        name: '領先步數',
        nameLocation: 'middle',
        nameGap: 28,
        nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
        axisLine: { lineStyle: { color: SPLIT_LINE } },
        axisTick: { show: false },
        axisLabel: { color: AXIS_TEXT, interval: 7, fontSize: 11 },
      },
      yAxis: valueYAxis('|誤差| kW'),
      series: [
        {
          name: '絕對誤差',
          type: 'bar',
          data: errs.map((e) => e.err),
          itemStyle: { color: 'rgba(168,85,247,0.55)' },
        },
      ],
    }
  }, [aligned])

  const coverage =
    options.length > 0
      ? `${shortLabel(options[0])} ～ ${shortLabel(options[options.length - 1])}`
      : '—'

  return (
    <>
      {/* 誤差指標 */}
      <div className="grid kpi" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <StatCard
          icon="📏"
          label="MAE 平均絕對誤差"
          value={m ? m.mae.toFixed(3) : '—'}
          unit="kW"
          sub={m ? `平均負載 ${m.meanActual} kW` : '待載入'}
          color={COLORS.load}
        />
        <StatCard
          icon="📐"
          label="RMSE 均方根誤差"
          value={m ? m.rmse.toFixed(3) : '—'}
          unit="kW"
          sub="對大誤差較敏感"
          color={COLORS.grid}
        />
        <StatCard
          icon="🎯"
          label="R² 決定係數"
          value={m?.r2 != null ? m.r2.toFixed(3) : '—'}
          sub="1 = 完美、0 = 等同猜平均"
          color={COLORS.save}
        />
        <StatCard
          icon="％"
          label="MAPE 平均絕對百分比誤差"
          value={m?.mape != null ? m.mape.toFixed(1) : '—'}
          unit="%"
          sub={m ? `${m.n} 個比對點` : '待載入'}
          color={COLORS.solar}
        />
      </div>

      {/* 預測 vs 真實 */}
      <Panel
        className="mt-16"
        title="不可轉移負載：預測 vs 真實"
        sub="選定刷新時刻起，未來 96 步（24 小時、每 15 分鐘）的滾動預測"
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="badge">
              {status === 'ok' ? '🌐 Supabase 雲端' : status === 'loading' ? '載入中…' : '⚠ 連線失敗'}
            </span>
            <select
              className="badge"
              value={refresh ?? ''}
              onChange={(e) => setRefresh(e.target.value)}
              disabled={!options.length}
              style={{
                cursor: 'pointer',
                background: 'var(--bg-elevated)',
                color: 'var(--text)',
                borderColor: 'var(--border-strong)',
                outline: 'none',
              }}
            >
              {options.map((t) => (
                <option key={t} value={t}>
                  刷新於 {shortLabel(t)}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {status === 'error' ? (
          <div className="muted" style={{ padding: 24 }}>
            讀取雲端資料失敗：{errMsg}
            <br />
            請確認 Supabase 專案未被暫停，或 <code>.env.local</code> 的 URL／anon key 是否正確。
          </div>
        ) : (
          <EChart option={compareOption} height={300} />
        )}
      </Panel>

      {/* 誤差隨領先步數 */}
      <Panel
        className="mt-16"
        title="誤差隨領先步數變化"
        sub="領先 1 步 = 15 分鐘後、96 步 = 24 小時後；愈往後預測愈困難"
      >
        <EChart option={errorOption} height={230} />
      </Panel>

      {/* 說明 */}
      <Panel className="mt-16" title="這頁在看什麼">
        <div className="muted" style={{ lineHeight: 1.9, fontSize: 13 }}>
          <p style={{ margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text)' }}>不可轉移負載</strong>＝整戶總用電 −
            三個可轉移分錶（廚房、洗衣、熱水器＋空調），也就是必須即時供電、無法挪移的基礎用電。
            這是 GA 電池排程一定要被滿足的部分，所以預測它的準確度直接決定排程品質。
          </p>
          <p style={{ margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text)' }}>滾動預測</strong>：每 15
            分鐘以「當下最後觀測時刻」為起點，重新預測未來 24 小時（96 步）。
            上圖選的是其中一個刷新時刻。
          </p>
          <p style={{ margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text)' }}>真實值只用來事後驗證</strong>。
            實際部署時沒有未來的真實值，GA 只能吃預測值——拿真實值排程等於偷看答案。
          </p>
          <p style={{ margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text)' }}>關於日期</strong>：資料集是 UCI
            household_power_consumption（法國 Sceaux 住宅，2010 年 11 月），所以這頁的時間軸是
            2010 年的原始日期。主頁面／用電規劃為了呈現「今日、明日」的情境，
            是把同一批預測<strong style={{ color: 'var(--text)' }}>依一日中的時段（0~95）對齊</strong>到畫面當天——
            曲線形狀完全是模型的真實輸出，只有日期標籤換掉。接上即時資料後這層對齊即可移除。
          </p>
          <p style={{ margin: 0 }}>
            資料來源：<code>{SUPABASE_INFO.url}</code> 的 <code>load_forecast</code> ／
            <code>actual_load</code> 表（anon key 只讀）。涵蓋範圍 {coverage}。
          </p>
        </div>
      </Panel>
    </>
  )
}
