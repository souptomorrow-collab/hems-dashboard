/* ============================================================
   系統資訊（只有管理員看得到）

   住戶不需要知道的系統內部設定集中在這一頁：帳號角色、電池規格、
   可轉移設備的規則、電價表，以及各份資料快照是哪一天、什麼時候匯出的。
   全部唯讀；要改設定請改原始碼（位置寫在各區塊的說明裡）。
   ============================================================ */
import { useEffect, useState } from 'react'
import Panel from '../components/Panel.jsx'
import { BATTERY, DEVICES, CATEGORY_LABEL } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { PRICE } from '../lib/tou.js'
import { SEASONS } from '../lib/scenario.js'
import { fetchDayAheadForecast, fetchWeatherData, fetchSchedules, cached, apiBase } from '../api/forecastData.js'
import { fetchHistory } from '../api/client.js'
import { ACCOUNTS, useAuth } from '../lib/auth.js'

/** ['2010-01-01', '2010-01-02', …] → 「2010-01-01～01-31、2010-07-01～07-31（共 62 天）」：連續的日子併成一段 */
function dateRanges(dates) {
  const ds = [...new Set(dates)].sort()
  const day = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000
  const parts = []
  let start = ds[0]
  for (let i = 1; i <= ds.length; i++) {
    if (i < ds.length && day(ds[i]) === day(ds[i - 1]) + 1) continue
    const end = ds[i - 1]
    parts.push(end === start ? start : `${start}～${end.slice(0, 4) === start.slice(0, 4) ? end.slice(5) : end}`)
    start = ds[i]
  }
  return `${parts.join('、')}（共 ${ds.length} 天）`
}

/** 資料是從哪裡讀到的：後端 API 即時讀取，或建置時匯出的靜態快照 */
const origin = (d) => (d?.via === 'api' ? `API 即時讀取・產生於 ${d.generatedAt ?? '—'}` : `快照・匯出於 ${d?.generatedAt ?? '—'}`)

const ROLE_SEES = {
  resident: '主頁面、各負載功率、用電規劃（可拖曳調整）、歷史紀錄與匯出；預測模型相關的圖與資料來源不顯示',
  admin: '住戶看得到的全部，加上太陽能預測與實際、負載預測與實際、資料來源標示、夏月／非夏月情境切換、展示模式、本頁',
}

export default function System() {
  const session = useAuth()
  const [meta, setMeta] = useState(null)

  useEffect(() => {
    let on = true
    const safe = (p) => p.catch((e) => ({ error: e?.message ?? String(e) }))
    Promise.all([
      ...SEASONS.map((s) => safe(cached(`day-ahead-forecast:${s.key}`, () => fetchDayAheadForecast(s.key)))),
      safe(cached('weather', fetchWeatherData)),
      fetchHistory(),
      safe(cached('schedule', fetchSchedules)),
    ]).then(([summer, nonSummer, weather, history, schedule]) =>
      on && setMeta({ summer, nonSummer, weather, history, schedule }))
    return () => { on = false }
  }, [])

  const snapshot = (label, file, d) => ({
    label,
    file,
    ok: d && !d.error,
    date: d?.targetDate ?? '—',
    detail: d?.error ? d.error : d ? `${origin(d)}${d.pv ? '・含太陽能預測' : '・無太陽能預測'}` : '讀取中…',
  })
  const dataRows = meta
    ? [
        snapshot('夏月展示日', 'forecast_day.json', meta.summer),
        snapshot('非夏月展示日', 'forecast_day_non_summer.json', meta.nonSummer),
        {
          label: '台北天氣（ERA5）',
          file: 'weather.json',
          ok: meta.weather && !meta.weather.error,
          date: meta.weather?.days ? `${Object.keys(meta.weather.days).length} 天` : '—',
          detail: meta.weather?.error ?? meta.weather?.source ?? '—',
        },
        {
          label: '歷史紀錄（逐日）',
          file: 'history.json',
          ok: Boolean(meta.history),
          date: meta.history ? `${meta.history.days.length} 天` : '—',
          detail: meta.history ? origin(meta.history) : '讀取失敗',
        },
        (() => {
          const s = meta.schedule
          const plans = s && !s.error ? Object.values(s.byDate) : []
          return {
            label: '排程組排程（MILP）',
            file: 'schedule.json',
            ok: Boolean(s && !s.error),
            date: plans.length ? dateRanges(plans.map((p) => p.date)) : s?.error ? '—' : '無',
            detail: s?.error
              ? s.error
              : `${origin(s)}・電價相符的日子電池照排程，其他日子用模擬調度`,
          }
        })(),
      ]
    : []

  return (
    <>
      <div className="grid cols-2">
        <Panel title="帳號與權限" sub={`目前登入：${session?.username}（${session?.label}）`}>
          {/* 手機上表格比畫面寬、要左右捲動：tabIndex 讓鍵盤也能選到再用方向鍵捲 */}
          <div className="table-wrap" tabIndex={0} role="region" aria-label="帳號與權限表">
            <table className="history-table compact">
              <thead>
                <tr>
                  <th>帳號</th>
                  <th>角色</th>
                  <th>看得到的內容</th>
                </tr>
              </thead>
              <tbody>
                {ACCOUNTS.map((a) => (
                  <tr key={a.username}>
                    <td>{a.username}</td>
                    <td><span className={`badge role-${a.role}`}>{a.label}</span></td>
                    <td className="wrap">{ROLE_SEES[a.role]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint prose mt-16">
            {'⚠️ 後端 API 目前只提供唯讀資料，登入仍在瀏覽器裡檢查，只用來區分住戶與管理員看到的畫面，不是資安保護：'}
            {'懂技術的人看原始碼可以繞過，資料檔也仍能直接下載。修改帳密請用 npm run hash-password，'}
            {'把產生的設定貼到 src/lib/auth.js。'}
          </p>
        </Panel>

        <Panel title="資料來源" sub={apiBase ? `先讀後端 API（${apiBase}），讀不到才用靜態快照；天氣一律讀快照` : '網站讀取的靜態快照（public/data，由 MongoDB 與 open-meteo 匯出）'}>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="資料快照表">
            <table className="history-table compact">
              <thead>
                <tr>
                  <th>資料</th>
                  <th>狀態</th>
                  <th>內容</th>
                </tr>
              </thead>
              <tbody>
                {!meta && (
                  <tr><td colSpan={3} className="dim">讀取中…</td></tr>
                )}
                {dataRows.map((r) => (
                  <tr key={r.file}>
                    <td>
                      {r.label}
                      <div className="dim mono">{r.file}</div>
                    </td>
                    <td className={r.ok ? 'status-ok' : 'status-bad'}>{r.ok ? '● 正常' : '● 讀取失敗'}</td>
                    <td className="wrap">
                      {r.date}
                      <div className="dim">{r.detail}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="grid cols-2 mt-16">
        <Panel title="電池規格" sub="Tesla Powerwall 2・設定在 src/lib/constants.js">
          <dl className="kv-list">
            <dt>可用容量</dt><dd>{BATTERY.capacityKwh} kWh</dd>
            <dt>最大充放電功率</dt><dd>{BATTERY.maxPowerKw} kW</dd>
            <dt>SOC 上限</dt><dd>{Math.round(BATTERY.socMax * 100)}%</dd>
            <dt>SOC 下限</dt><dd>{Math.round(BATTERY.socMin * 100)}%</dd>
            <dt>每天起始 SOC</dt><dd>{Math.round(BATTERY.socInit * 100)}%</dd>
            <dt>往返效率</dt><dd>{Math.round(BATTERY.roundTrip * 100)}%（照排程組排程時計入，充電時扣除；模擬調度尚未計入）</dd>
          </dl>
        </Panel>

        <Panel title="台電簡易二段式電價" sub="元／度・設定在 src/lib/tou.js">
          <div className="table-wrap" tabIndex={0} role="region" aria-label="電價表">
            <table className="history-table compact">
              <thead>
                <tr>
                  <th>季節</th>
                  <th className="num">尖峰</th>
                  <th className="num">離峰</th>
                  <th>平日尖峰時段</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>夏月（6/1～9/30）</td>
                  <td className="num">{PRICE.summer.peak.toFixed(2)}</td>
                  <td className="num">{PRICE.summer.offpeak.toFixed(2)}</td>
                  <td className="wrap">09:00–24:00</td>
                </tr>
                <tr>
                  <td>非夏月</td>
                  <td className="num">{PRICE.nonSummer.peak.toFixed(2)}</td>
                  <td className="num">{PRICE.nonSummer.offpeak.toFixed(2)}</td>
                  <td className="wrap">06:00–11:00、14:00–24:00</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint prose mt-16">{'週六、週日全天離峰（未計入國定假日）。'}</p>
        </Panel>
      </div>

      <Panel title="設備與運轉規則" sub="額定功率與可轉移設備的建議範圍（沒排的設備不開）・設定在 src/lib/constants.js、src/lib/simulate.js" className="mt-16">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="設備與運轉規則表">
          <table className="history-table compact">
            <thead>
              <tr>
                <th>設備</th>
                <th>分類</th>
                <th className="num">額定功率</th>
                <th className="num">一次運轉</th>
                <th>建議範圍（照建議時系統在這裡面排）</th>
              </tr>
            </thead>
            <tbody>
              {DEVICES.map((d) => {
                const rule = SHIFTABLE_RULES[d.id]
                return (
                  <tr key={d.id}>
                    <td>{d.icon} {d.name}</td>
                    <td>
                      <span className={`badge ${d.category === 'shiftable' ? 'shiftable' : 'fixed'}`}>
                        {CATEGORY_LABEL[d.category]}
                      </span>
                    </td>
                    <td className="num">{d.ratedW} W</td>
                    <td className="num">{rule ? `${(rule.dur * 15) / 60} 小時` : '—'}</td>
                    <td className="wrap">{rule ? rule.text : '依作息，由負載預測涵蓋'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
