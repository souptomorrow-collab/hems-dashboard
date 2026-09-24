import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from './Panel'
import EChart from './EChart'
import { cached, getJson, fetchSchedules, fetchOperation } from '../api/forecastData'
import { useScenario, useScenarioDays } from '../lib/scenario.js'
import { useDemoClock, seekDemoSec } from '../lib/demoClock.js'
import { useTheme } from '../lib/theme.js'
import { baseTooltip, valueYAxis, AXIS_TEXT, SPLIT_LINE } from '../lib/charts.js'
import { useMediaQuery } from '../hooks/useMediaQuery.js'
import { DEVICES } from '../lib/constants.js'

/* 秒級重播：把展示日的每秒資料播給實時運轉層看。

   為什麼資料不是從資料庫來：秒級一年 3,150 萬筆，雲端資料庫（免費方案 512 MB）放不下，
   其他組也用不到。所以兩個展示月每天做成一個小檔跟著網站部署（各約 1 MB，
   兩條 86,400 點的陣列，不存時間戳，時刻由位置推算），選到哪天才讀哪天：
     public/data/realtime/YYYY-MM-DD.json
   夏月情境可選 2010-07，非夏月可選 2010-01；換月份就重跑 scripts/make_realtime_snapshot.py。
   15 分鐘的計畫值仍然來自資料庫（排程），兩者在畫面上疊在一起看——
   看得到實時層在兩次排程之間怎麼跟著實際負載走。

   展示模式開著時，重播跟著展示時鐘走（日期固定在展示日、時刻就是展示時鐘的時刻），
   速度在上方的展示列調：1 分鐘＝1 秒時一格要 15 秒，看得到實時層逐秒怎麼跟著實際負載修正。

   ★ 分鐘級以上是實測，分鐘之內是合成；太陽能連 15 分鐘平均都是日射量換算，不是實測出力。 */

const SPEEDS = [1, 60, 300, 900]          // 1 秒＝1 秒 / 1 分 / 5 分 / 15 分
// 兩個展示月：情境切到哪一季，就只能選那個月；預設停在展示日
const MONTHS = {
  summer: { month: '2010-07', days: 31, show: '2010-07-19' },
  non_summer: { month: '2010-01', days: 31, show: '2010-01-11' },
}
const WINDOW_S = 900                      // 畫面上顯示最近 15 分鐘
const RATED_KW = Object.fromEntries(
  DEVICES.filter((d) => d.category === 'shiftable').map((d) => [d.id, d.ratedW / 1000]))
const TICK_MS = 100                       // 每 0.1 秒推進一次，播放才順

const hhmmss = (s) =>
  `${String((s / 3600) | 0).padStart(2, '0')}:${String(((s / 60) | 0) % 60).padStart(2, '0')}`
  + `:${String(s % 60).padStart(2, '0')}`

export default function SecondReplay() {
  const { season } = useScenario()
  const theme = useTheme() // 主題一換，圖表的座標軸、圖例顏色跟著換
  const range = MONTHS[season] ?? MONTHS.summer
  const { today: home } = useScenarioDays() // 平常停在展示日；展示模式下跟著播放的那一天
  const [picked, setDay] = useState(home)
  const [data, setData] = useState(null)
  const [plan, setPlan] = useState(null)
  const [op, setOp] = useState(null)        // 實時層實際做了什麼（actual_operation）
  const [err, setErr] = useState(null)
  const [ownSec, setSec] = useState(0)
  // 展示模式：跟著展示時鐘（展示日、展示時鐘的時刻），自己的播放鈕與日期都停用
  const demo = useDemoClock()
  const locked = demo.enabled
  const day = locked ? home : picked
  const sec = locked ? demo.sec : ownSec
  const [speed, setSpeed] = useState(60)
  const [playing, setPlaying] = useState(false)
  const carry = useRef(0)                 // 不足 1 秒的餘數，換速度時不會跳動

  // 切換情境就回到那一季的展示日
  useEffect(() => { setDay(home) }, [home])

  useEffect(() => {
    let on = true
    setData(null); setPlan(null); setOp(null); setErr(null); setSec(0); setPlaying(false)
    cached(`realtime_${day}`, () => getJson(`realtime/${day}.json`))
      .then((d) => {
        if (!on) return
        setData(d)
        // 同一天的 15 分鐘排程計畫（來自資料庫），拿來和秒級實際值對照
        cached('schedule', fetchSchedules)
          .then((s) => on && setPlan(s?.byDate?.[d.date] ?? null))
          .catch(() => on && setPlan(null))
        // 同一天實時層的實際結果：和計畫對照，看得到它怎麼跟著實際負載修正
        cached('operation', fetchOperation)
          .then((o) => on && setOp(o?.byDate?.[d.date] ?? null))
          .catch(() => on && setOp(null))
      })
      .catch((e) => on && setErr(e.message))
    return () => { on = false }
  }, [day])

  useEffect(() => {
    if (!playing || !data || locked) return undefined
    const id = setInterval(() => {
      carry.current += (speed * TICK_MS) / 1000
      const step = Math.floor(carry.current)
      if (!step) return
      carry.current -= step
      setSec((s) => (s + step) % data.n)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [playing, speed, data])

  // 可轉移設備每一格的功率：實時層實際開機的時間（op.devices）× 額定功率；沒有實時紀錄才用日前排程的預估。
  // 秒級檔只有不可轉移負載，設備照額定功率加上去，和實時運轉的負載（本來就含設備）才對得上
  const devKw = useMemo(() => {
    const out = new Array(96).fill(0)
    for (const [id, on] of Object.entries(op?.devices ?? plan?.devices ?? {})) {
      on.forEach((v, k) => { if (v) out[k] += RATED_KW[id] ?? 0 })
    }
    return out
  }, [plan, op])

  const view = useMemo(() => {
    if (!data) return null
    const lo = Math.max(0, sec - WINDOW_S + 1)
    const x = []
    const load = []
    const pv = []
    for (let i = lo; i <= sec; i++) {
      x.push(hhmmss(i))
      load.push(+(data.load_kw[i] + devKw[Math.floor(i / 900)]).toFixed(3))
      pv.push(data.pv_kw[i])
    }
    return { x, load, pv }
  }, [data, sec, devKw])

  // 這一秒所屬的 15 分鐘格，以及排程對這一格的計畫值
  const slot = Math.floor(sec / 900)
  const planRow = plan
    ? {
        load_kw: plan.load_kw[slot], pv_kw: plan.pv_kw[slot],
        grid_buy_kw: plan.grid_buy_kw[slot], batt_kw: plan.batt_kw[slot], soc_pct: plan.soc_pct[slot],
      }
    : null
  const opRow = op
    ? { grid_kw: op.grid_kw[slot], batt_kw: op.batt_kw[slot], soc_pct: op.soc_pct[slot],
        curtail_kw: op.curtail_kw[slot] }
    : null
  const now = data ? { load: data.load_kw[sec] + devKw[slot], pv: data.pv_kw[sec], dev: devKw[slot] } : null

  // 曲線直接在右端標名稱（實線＝實際每秒、虛線＝排程對這一格的計畫）。原本靠上方圖例，
  // 四條線兩兩同色系分不出來，手機上圖例還被分成三頁、看不到虛線是什麼
  const narrow = useMediaQuery('(max-width: 760px)')
  const option = useMemo(() => {
    if (!view) return {}
    const tag = (text, color) => ({
      show: true, color, fontSize: 11, fontWeight: 700, distance: 6,
      formatter: (p) => (narrow ? text : `${text} ${(+p.value).toFixed(2)}`),
    })
    const series = (name, text, arr, color, extra = {}) => ({
      name, type: 'line', data: arr, symbol: 'none', smooth: false,
      lineStyle: { width: 1.8, color }, itemStyle: { color },
      endLabel: tag(text, color), labelLayout: { moveOverlap: 'shiftY' }, ...extra,
    })
    // 實際與計畫的尾端很接近（例如夜裡太陽能兩條都是 0）時，兩個標籤會疊在一起：只留一個、不分實際計畫
    const last = (a) => a[a.length - 1]
    const top = Math.max(1, ...view.load, ...view.pv, planRow?.load_kw ?? 0, planRow?.pv_kw ?? 0)
    const close = (a, v) => planRow && Math.abs(last(a) - v) < top * 0.06
    const both = { load: close(view.load, planRow?.load_kw), pv: close(view.pv, planRow?.pv_kw) }
    const s = [
      series('負載・實際（每秒，含可轉移設備）', both.load ? '負載' : '負載實際', view.load, '#ef6c4d'),
      series('太陽能・實際（每秒）', both.pv ? '太陽能' : '太陽能實際', view.pv, '#e0a100'),
    ]
    if (planRow) {
      const flat = (v, name, text, color, hide) => series(name, text, view.x.map(() => v), color, {
        lineStyle: { width: 1.6, type: [6, 4], color },
        ...(hide ? { endLabel: { show: false } } : {}),
      })
      s.push(flat(planRow.load_kw, '負載・本格計畫', '負載計畫', '#c0502e', both.load))
      s.push(flat(planRow.pv_kw, '太陽能・本格計畫', '太陽能計畫', '#a98200', both.pv))
    }
    return {
      // top 要留給 y 軸名稱「kW」：原本 24px，軸名上緣被切掉
      grid: { left: 46, right: narrow ? 74 : 118, top: 36, bottom: 28 },
      tooltip: { ...baseTooltip },
      xAxis: {
        type: 'category', data: view.x,
        axisLine: { lineStyle: { color: SPLIT_LINE } }, axisTick: { show: false },
        // 只在整分鐘標 HH:MM（桌機每 3 分鐘、手機每 5 分鐘），原本標「10:18:01」手機上會擠成一串
        axisLabel: {
          fontSize: 11, color: AXIS_TEXT,
          interval: (_i, v) => v.endsWith(':00') && +v.slice(3, 5) % (narrow ? 5 : 3) === 0,
          formatter: (v) => v.slice(0, 5),
        },
      },
      yAxis: valueYAxis('kW', { min: 0 }),
      series: s,
      animation: false,
    }
  }, [view, planRow, theme, narrow])

  const picker = (
    <label className="replay-day">
      <span className="sr-only">重播哪一天</span>
      <input
        id="replay-day"
        type="date"
        value={day}
        min={`${range.month}-01`}
        max={`${range.month}-${String(range.days).padStart(2, '0')}`}
        onChange={(e) => e.target.value && setDay(e.target.value)}
        disabled={locked}
        title={locked ? '展示模式下固定在展示日' : undefined}
      />
    </label>
  )
  if (err) return <Panel title="秒級重播" right={picker}><div className="muted">讀取失敗：{err}</div></Panel>
  if (!data) return <Panel title="秒級重播" right={picker}><div className="muted">載入 {day}…</div></Panel>

  return (
    <Panel
      title="秒級重播"
      right={
        <div className="replay-ctl">
          {picker}
          {locked ? null : (
            <>
              <button className="btn" onClick={() => setPlaying((p) => !p)}>
                {playing ? '暫停' : '播放'}
              </button>
              {SPEEDS.map((v) => (
                <button
                  key={v}
                  className={`btn ${v === speed ? 'on' : ''}`}
                  onClick={() => setSpeed(v)}
                >
                  {v}×
                </button>
              ))}
            </>
          )}
        </div>
      }
    >
      <div className="replay-now">
        <div><span>負載</span><b>{now.load.toFixed(2)}</b> kW</div>
        <div><span>太陽能</span><b>{now.pv.toFixed(2)}</b> kW</div>
        <div><span>淨負載</span><b>{(now.load - now.pv).toFixed(2)}</b> kW</div>
        {planRow && (
          <div className="plan">
            <span>本格計畫（{hhmmss(slot * 900).slice(0, 5)}）</span>
            <b>購電 {planRow.grid_buy_kw.toFixed(2)}</b> kW・
            <b>電池 {planRow.batt_kw.toFixed(2)}</b> kW・
            <b>SOC {planRow.soc_pct.toFixed(1)}</b>%
          </div>
        )}
        {opRow && (
          <div className="plan actual">
            <span>實時層實際</span>
            <b>購電 {opRow.grid_kw.toFixed(2)}</b> kW・
            <b>電池 {opRow.batt_kw.toFixed(2)}</b> kW・
            <b>SOC {opRow.soc_pct.toFixed(1)}</b>%
            {opRow.curtail_kw > 0.005 && <>・棄光 {opRow.curtail_kw.toFixed(2)} kW</>}
          </div>
        )}
      </div>
      <input
        type="range"
        min={0}
        max={data.n - 1}
        value={sec}
        onChange={(e) => (locked ? seekDemoSec(Number(e.target.value)) : setSec(Number(e.target.value)))}
        style={{ width: '100%' }}
        aria-label="重播進度"
      />
      <EChart option={option} height={260} label={`秒級重播：${data.date} 最近 15 分鐘的負載與太陽能`} />
    </Panel>
  )
}
