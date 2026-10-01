import { useEffect, useMemo, useState } from 'react'
import Panel from './Panel'
import EChart from './EChart'
import { cached, getJson, fetchSchedules, fetchOperation, fetchPlans } from '../api/forecastData'
import { useScenario, useScenarioDays } from '../lib/scenario.js'
import { useDemoClock, seekDemoSec } from '../lib/demoClock.js'
import { nowTaipei } from '../lib/time.js'
import { useTheme } from '../lib/theme.js'
import { baseTooltip, valueYAxis, AXIS_TEXT, SPLIT_LINE } from '../lib/charts.js'
import { useMediaQuery } from '../hooks/useMediaQuery.js'
import { COLORS, DEVICES } from '../lib/constants.js'
import { simulateSlot } from '../lib/secControl.js'

/* 實時控制（每秒）：實時運轉層每秒在做什麼（2026-10-01 由「秒級重播」改來——
   原本只畫每秒的負載、太陽能和本格計畫，看不出實時層的作用）。

   畫面上（最近 15 分鐘，每秒）：電池功率（正＝充電）與本格排程目標（虛線）、電網購電、負載－太陽能（淨負載）、棄光。
   看得到的事：電池貼著排程目標、累計誤差慢慢補回；太陽能多出負載時電池當秒多吸收、電網購電不低於 0（防逆送）；
   電池充滿才棄光；負載的秒級跳動由電網承擔。下面一排是這一格到目前為止的統計。

   電池、電網、棄光是網頁照排程組的 step_1sec_control 逐秒重算的（lib/secControl.js），輸入都是網頁拿得到的：
     每秒負載與太陽能：public/data/realtime/YYYY-MM-DD.json（兩個展示月每天一檔，跟著網站部署，不經過資料庫——
       秒級一年 3,150 萬筆，免費資料庫放不下）；可轉移設備照實際開機時間（operation 的 devices）× 額定功率加上去
     本格排程目標：該格重排計畫的第 1 格（/plans?date=，tag=rolling）
     上一格結束的電量與累計誤差：實時運轉紀錄（/operation 的 soc_pct、err_kwh）
   和資料庫的實時運轉紀錄比對過：每格平均最大差約 0.02 kW。

   重播一律跟著時鐘走，日期固定在「今天」（展示月的日子）：
     一般模式＝真實時間，每秒前進一秒；展示模式＝展示時鐘的時刻，速度在上方的展示列調。

   ★ 分鐘級以上是實測，分鐘之內是合成；太陽能連 15 分鐘平均都是日射量換算，不是實測出力。 */

// 兩個展示月：情境切到哪一季，就是那個月
const MONTHS = {
  summer: { month: '2010-07', days: 31, show: '2010-07-19' },
  non_summer: { month: '2010-01', days: 31, show: '2010-01-11' },
}
const WINDOW_S = 900                      // 畫面上顯示最近 15 分鐘
const RATED_KW = Object.fromEntries(
  DEVICES.filter((d) => d.category === 'shiftable').map((d) => [d.id, d.ratedW / 1000]))
const NET_COLOR = '#94a3b8'
/** 一般模式的「現在」是當天第幾秒（真實時間） */
const secOfDay = (t = nowTaipei()) => t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds()

const hhmmss = (s) =>
  `${String((s / 3600) | 0).padStart(2, '0')}:${String(((s / 60) | 0) % 60).padStart(2, '0')}`
  + `:${String(s % 60).padStart(2, '0')}`
/** 前一天（YYYY-MM-DD） */
const prevDate = (d) => {
  const [y, m, dd] = d.split('-').map(Number)
  const t = new Date(y, m - 1, dd - 1)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}
/** 電池功率寫成「充電／放電 x.xx」 */
const battText = (v) => (Math.abs(v) < 0.005 ? '0.00' : v > 0 ? `充電 ${v.toFixed(2)}` : `放電 ${(-v).toFixed(2)}`)

export default function SecondReplay() {
  const { season } = useScenario()
  const theme = useTheme() // 主題一換，圖表的座標軸、圖例顏色跟著換
  const range = MONTHS[season] ?? MONTHS.summer
  const { today: day } = useScenarioDays() // 一般模式＝今天對到的展示日；展示模式＝播放中的那一天
  const [data, setData] = useState(null)
  const [plan, setPlan] = useState(null)    // 日前排程（只在沒有實時紀錄時拿來估設備開機）
  const [ops, setOps] = useState(null)      // 實時運轉紀錄（依日期）：設備開機、每格結束的電量與累計誤差
  const [plans, setPlans] = useState(null)  // 這一天每 15 分鐘重排的計畫：第 1 格＝那一格的排程目標
  const [err, setErr] = useState(null)
  // 時刻：展示模式跟著展示時鐘；一般模式跟著真實時間，每秒更新
  const demo = useDemoClock()
  const [liveSec, setLiveSec] = useState(secOfDay)
  useEffect(() => {
    if (demo.enabled) return undefined
    const id = setInterval(() => setLiveSec(secOfDay()), 1000)
    return () => clearInterval(id)
  }, [demo.enabled])
  const sec = demo.enabled ? demo.sec : liveSec

  useEffect(() => {
    let on = true
    setData(null); setPlan(null); setOps(null); setPlans(null); setErr(null)
    cached(`realtime_${day}`, () => getJson(`realtime/${day}.json`))
      .then((d) => {
        if (!on) return
        setData(d)
        cached('schedule', fetchSchedules)
          .then((s) => on && setPlan(s?.byDate?.[d.date] ?? null))
          .catch(() => on && setPlan(null))
        cached('operation', fetchOperation)
          .then((o) => on && setOps(o?.byDate ?? {}))
          .catch(() => on && setOps({}))
        cached(`plans_${d.date}`, () => fetchPlans(d.date))
          .then((p) => on && setPlans(p?.bySlot ?? null))
          .catch(() => on && setPlans(null))
      })
      .catch((e) => on && setErr(e.message))
    return () => { on = false }
  }, [day])

  const op = ops?.[day] ?? null
  const prevOp = ops?.[prevDate(day)] ?? null

  // 可轉移設備每一格的功率：實時層實際開機的時間（op.devices）× 額定功率；沒有實時紀錄才用日前排程的預估。
  // 秒級檔只有不可轉移負載，設備照額定功率加上去，和實時運轉的負載（本來就含設備）才對得上
  const devKw = useMemo(() => {
    const out = new Array(96).fill(0)
    for (const [id, onArr] of Object.entries(op?.devices ?? plan?.devices ?? {})) {
      onArr.forEach((v, k) => { if (v) out[k] += RATED_KW[id] ?? 0 })
    }
    return out
  }, [plan, op])

  // 每一格的起始狀態：上一格結束的電量與累計誤差（第 1 格接前一天最後一格；月初沒有前一天＝15%、0）
  const startOf = (s) => {
    if (s > 0 && op) return { soc0: op.soc_pct[s - 1] / 100, err0: op.err_kwh?.[s - 1] ?? 0 }
    if (s === 0 && prevOp) return { soc0: prevOp.soc_pct[95] / 100, err0: prevOp.err_kwh?.[95] ?? 0 }
    return { soc0: 0.15, err0: 0 }
  }
  const targetOf = (s) => plans?.[s]?.batt_kw?.[0] ?? op?.batt_kw?.[s] ?? 0

  // 最近 15 分鐘逐秒重算（跨兩格時，兩格各自從開頭跑起，起始狀態用實時紀錄）
  const view = useMemo(() => {
    if (!data || !ops) return null
    const lo = Math.max(0, sec - WINDOW_S + 1)
    const v = { x: [], batt: [], tgt: [], grid: [], net: [], curt: [], cur: null }
    for (let s = Math.floor(lo / 900); s <= Math.floor(sec / 900); s++) {
      const target = targetOf(s)
      const r = simulateSlot({ load: data.load_kw, pv: data.pv_kw, slot: s, upto: sec, dev: devKw[s], target, ...startOf(s) })
      for (let i = 0; i < r.batt.length; i++) {
        const t = r.t0 + i
        if (t < lo) continue
        v.x.push(hhmmss(t))
        v.batt.push(+r.batt[i].toFixed(3)); v.tgt.push(+target.toFixed(3)); v.grid.push(+r.grid[i].toFixed(3))
        v.net.push(+r.net[i].toFixed(3)); v.curt.push(+r.curt[i].toFixed(3))
      }
      v.cur = { slot: s, target, ...r.stats }
    }
    return v
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ops, plans, sec, devKw])

  // 曲線直接在右端標名稱。原本靠上方圖例，手機上圖例被分成好幾頁
  const narrow = useMediaQuery('(max-width: 760px)')
  const option = useMemo(() => {
    if (!view || !view.x.length) return {}
    const tag = (text, color) => ({
      show: true, color, fontSize: 11, fontWeight: 700, distance: 6,
      formatter: (p) => (narrow ? text : `${text} ${(+p.value).toFixed(2)}`),
    })
    const series = (name, text, arr, color, extra = {}) => ({
      name, type: 'line', data: arr, symbol: 'none', smooth: false,
      lineStyle: { width: 1.8, color }, itemStyle: { color },
      endLabel: tag(text, color), labelLayout: { moveOverlap: 'shiftY' }, ...extra,
    })
    const last = (a) => a[a.length - 1]
    const s = [
      series('負載－太陽能（每秒）', '淨負載', view.net, NET_COLOR, { lineStyle: { width: 1.2, color: NET_COLOR } }),
      series('電網購電（每秒）', '購電', view.grid, COLORS.grid),
      series('電池・本格排程目標', '目標', view.tgt, COLORS.battery, {
        lineStyle: { width: 1.6, type: [6, 4], color: COLORS.battery },
        // 電池貼著目標時兩個標籤會疊在一起：只留電池的
        ...(Math.abs(last(view.batt) - last(view.tgt)) < 0.15 ? { endLabel: { show: false } } : {}),
      }),
      series('電池（每秒，正＝充電）', '電池', view.batt, COLORS.battery, { lineStyle: { width: 2.2, color: COLORS.battery } }),
    ]
    if (view.curt.some((v) => v > 0.001)) s.push(series('棄光（每秒）', '棄光', view.curt, COLORS.peak))
    return {
      // top 要留給 y 軸名稱「kW」
      grid: { left: 46, right: narrow ? 74 : 118, top: 36, bottom: 28 },
      tooltip: { ...baseTooltip },
      xAxis: {
        type: 'category', data: view.x,
        axisLine: { lineStyle: { color: SPLIT_LINE } }, axisTick: { show: false },
        // 只在整分鐘標 HH:MM（桌機每 3 分鐘、手機每 5 分鐘）
        axisLabel: {
          fontSize: 11, color: AXIS_TEXT,
          interval: (_i, v) => v.endsWith(':00') && +v.slice(3, 5) % (narrow ? 5 : 3) === 0,
          formatter: (v) => v.slice(0, 5),
        },
      },
      yAxis: valueYAxis('kW'),
      series: s,
      animation: false,
    }
  }, [view, theme, narrow])

  const picker = (
    <label className="replay-day">
      <span className="sr-only">重播哪一天</span>
      <input
        id="replay-day"
        type="date"
        value={day}
        min={`${range.month}-01`}
        max={`${range.month}-${String(range.days).padStart(2, '0')}`}
        disabled
        title="跟著時鐘，固定在今天"
      />
    </label>
  )
  const TITLE = '實時控制（每秒）'
  if (err) return <Panel title={TITLE} right={picker}><div className="muted">讀取失敗：{err}</div></Panel>
  if (!data || !view?.cur) return <Panel title={TITLE} right={picker}><div className="muted">載入 {day}…</div></Panel>

  const c = view.cur
  const at = view.batt.length - 1
  return (
    <Panel title={TITLE} right={<div className="replay-ctl">{picker}</div>}>
      <div className="replay-now">
        <div><span>本格排程目標（{hhmmss(c.slot * 900).slice(0, 5)}）</span><b>{battText(c.target)}</b> kW</div>
        <div><span>電池這一秒</span><b>{battText(view.batt[at])}</b> kW</div>
        <div><span>本格電池平均</span><b>{battText(c.battAvg)}</b> kW</div>
        <div><span>累計誤差</span><b>{c.err >= 0 ? '+' : ''}{c.err.toFixed(3)}</b> 度</div>
        <div><span>電網購電這一秒</span><b>{view.grid[at].toFixed(2)}</b> kW</div>
        <div>
          <span>本格多餘太陽能</span><b>{c.surplusKwh.toFixed(3)}</b> 度：電池吸收 <b>{c.absorbedKwh.toFixed(3)}</b>、
          棄光 <b>{c.curtKwh.toFixed(3)}</b>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={data.n - 1}
        value={Math.min(sec, data.n - 1)}
        onChange={(e) => seekDemoSec(Number(e.target.value))}
        disabled={!demo.enabled} // 一般模式是真實時間，不能拖
        style={{ width: '100%' }}
        aria-label="重播進度"
      />
      <EChart option={option} height={280}
        label={`實時控制：${data.date} 最近 15 分鐘每秒的電池功率、排程目標、電網購電與淨負載`} />
    </Panel>
  )
}
