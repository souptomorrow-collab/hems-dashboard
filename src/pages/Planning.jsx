import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import { fetchPlanning, recomputeSchedule, fetchRolling } from '../api/client.js'
import { DEVICES, COLORS, slotToTime } from '../lib/constants.js'
import DevicePrefs from '../components/DevicePrefs.jsx'
import { loadPrefs, savePrefs } from '../api/prefs.js'
import { useScenario, getScenario, useScenarioDays } from '../lib/scenario.js'
import { cached, fetchSchedules, SCHEDULES_REFRESHED } from '../api/forecastData.js'
import { PREFS_SAVED } from '../api/prefs.js'
import { useDemoEnabled, useDemoDay, getDemo, togglePlay } from '../lib/demoClock.js'
import { useCurrentSlot } from '../hooks/useClock.js'
import { useDataRevision } from '../hooks/useDataRevision.js'
import {
  SHIFT_IDS, defaultCond, recommendCond, recCond, followsRec, fromPrefs, toPrefs, condKey, estimate, estimateWithRec,
  recClash, rowsOf, startsFromRows, checkCond, durOf, latestStart, hardOk, inDefault, nameOf, hm, PLAN_CUTOFF_SLOT,
} from '../lib/deviceJobs.js'
import { pad2 } from '../lib/format.js'
import { useTheme } from '../lib/theme.js'
import {
  valueYAxis,
  baseTooltip,
  baseLegend,
  touMarkArea,
  powerSocLayout,
  powerSocFormatter,
  socYAxis,
  SOC_EXTRA_HEIGHT,
  socExtraHeight,
  TEXT_MAIN,
} from '../lib/charts.js'
import { PLAN_SOC_H, rollingOption } from '../lib/planChart.js'

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable') // 甘特圖只列可轉移設備
const STALL_MS = 3 * 60 * 1000 // 送出後 3 分鐘都沒有任何一天重排好，就不再等
const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '')

export default function Planning() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const [plan, setPlan] = useState(null)
  const [schedule, setSchedule] = useState(null)
  const [computing, setComputing] = useState(false)
  // 點到不允許運轉的格子時，短暫顯示原因（原本點了沒反應，看不出為什麼）
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(id)
  }, [notice])
  const { season } = useScenario()
  const demoOn = useDemoEnabled()
  const demoDay = useDemoDay()
  const curSlot = useCurrentSlot()
  const rev = useDataRevision() // 本機重算時每寫回一天就加一：未來 24 小時那份換新了要重抓
  // 資料集的隔日（展示月的日子）；今天是月底時是 null
  const { next: planDay } = useScenarioDays()
  const [cond, setCond] = useState(null) // 隔日各設備的條件（lib/deviceJobs.js）
  const [sent, setSent] = useState('') // 已送出（或雲端讀到）的條件，判斷有沒有改過
  // 排法：standing＝常駐排程（從隔日起每天都用）、day＝明日排程（只管隔日）。sentMode 是雲端讀到／已送出的
  const [mode, setMode] = useState('standing')
  const [sentMode, setSentMode] = useState('standing')
  // 基準 { cond, mode, starts, source, plan, rec, recCost }：載入時的，送出後換成送出的那一份。「復原更改」回到這裡。
  // recCost 是日前排程另外算的「三台都照建議」電費（MILP 設備和電池一起排；沒有是 null）
  const loaded = useRef(null)
  const [est, setEst] = useState(null) // 各設備預估幾點開（第幾格；不跑是 null）
  const [rec, setRec] = useState(null) // 建議時間：三台都照建議時各設備幾點開（第幾格）
  const [cmp, setCmp] = useState(null) // { recCost, diffs }：照建議排的電費、指定時間比建議時間多花多少
  const [sending, setSending] = useState(false)
  const [prefsMsg, setPrefsMsg] = useState('')
  const [rolling, setRolling] = useState(null) // 未來 24 小時（實時運轉層在這一格重排的計畫）
  const planRef = useRef(null) // 最新一次重算的結果（送出時記成基準；重算是非同步的）
  planRef.current = plan

  // 展示模式播放中進到這頁先暫停：拖甘特圖時隔日不會跟著播放換掉，調整完到上方按 ▶ 繼續
  useEffect(() => {
    if (getDemo().enabled && getDemo().playing) togglePlay()
  }, [])
  const [reload, setReload] = useState(0)
  // 送出後，等本機把隔日照這一版設定重排：{ stamp＝這次設定的版本, day＝送出的那天（null＝整個換掉） }
  const [awaiting, setAwaiting] = useState(null)
  // 本機從送出的那天起重排同一個月（電量一天接一天）：隔日在這個範圍內才等；換到別天（之前、別的月）不會換新，不等
  const waitHere = Boolean(awaiting && planDay
    && (!awaiting.day || (planDay.slice(0, 7) === awaiting.day.slice(0, 7) && planDay >= awaiting.day)))

  useEffect(() => {
    const onSaved = (e) => e.detail?.stamp && setAwaiting({ stamp: e.detail.stamp, day: e.detail.from ?? null })
    window.addEventListener(PREFS_SAVED, onSaved)
    return () => window.removeEventListener(PREFS_SAVED, onSaved)
  }, [])
  // 不自己輪詢：版面（Layout）在本機重算時每 10 秒重讀排程，有新寫回的日子就發
  // SCHEDULES_REFRESHED；隔日那份換成新設定就重新載入這頁的規劃。3 分鐘都沒有任何一天換新就不等了
  useEffect(() => {
    if (!waitHere) return undefined
    let on = true
    let timer = null
    let seen = null
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => on && setAwaiting(null), STALL_MS)
    }
    const done = (s) => s?.byDate?.[planDay]?.prefs_stamp === awaiting.stamp
    const onRefreshed = (e) => {
      if (!on) return
      if (done(e.detail)) {
        setAwaiting(null)
        setReload((n) => n + 1)
        return
      }
      // 有別的日子換新（本機還在算）就重新計時
      const sig = Object.values(e.detail?.byDate ?? {}).map((x) => x.prefs_stamp).join()
      if (sig !== seen) {
        seen = sig
        arm()
      }
    }
    window.addEventListener(SCHEDULES_REFRESHED, onRefreshed)
    arm()
    // 換到已經重排好的日子：快取裡的排程已是新的（這次載入就是新設定），不用再等
    cached('schedule', fetchSchedules).then((s) => on && done(s) && setAwaiting(null)).catch(() => {})
    return () => {
      on = false
      clearTimeout(timer)
      window.removeEventListener(SCHEDULES_REFRESHED, onRefreshed)
    }
  }, [waitHere, awaiting, planDay])

  // 進頁面即取得隔日的規劃與條件；切換情境、換天、本機重排好時重新載入，沒送出的更改一併清掉
  useEffect(() => {
    let on = true
    if (!planDay) return undefined // 今天是月底，沒有隔日可以規劃
    setComputing(true)
    setPrefsMsg('')
    ;(async () => {
      const p = await fetchPlanning(planDay)
      if (!on || !p) return
      const d = await loadPrefs(planDay) // 隔日的條件：明日排程（只管那天）或常駐排程（每天）
      if (!on) return
      const c = fromPrefs(d.devices)
      const fromPlan = p.planSource !== 'sim'
      // 建議時間：日前排程另外算的（三台都照建議的 MILP 解）；沒有時依電價估
      const recPlan = fromPlan && p.recommended?.start_slot
      const recStarts = recPlan
        ? Object.fromEntries(SHIFT_IDS.map((id) => [id, p.recommended.start_slot[id] ?? null]))
        : estimate(recommendCond(), p.price)
      const recCost = recPlan && Number.isFinite(p.recommended.cost) ? +p.recommended.cost.toFixed(1) : null
      // 預估時間：有日前排程就用排程的（MILP 把設備和電池一起排）；沒有排程時，照建議的用建議時間、其他依電價估
      const starts = fromPlan ? startsFromRows(p.schedule) : estimateWithRec(c, p.price, recStarts)
      const rows = { ...p.schedule, ...rowsOf(starts) }
      const cur = fromPlan ? p : await recomputeSchedule(rows, planDay)
      if (!on) return
      loaded.current = { cond: c, mode: d.mode, starts, source: fromPlan ? 'schedule' : 'price', plan: cur, rec: recStarts, recCost }
      setCond(c)
      setSent(condKey(c))
      setMode(d.mode)
      setSentMode(d.mode)
      setEst(starts)
      setRec(recStarts)
      setSchedule(rows)
      setPlan(cur)
      setComputing(false)
    })()
    return () => { on = false }
  }, [season, reload, planDay])

  // 未來 24 小時：每前進一格換一份（和主頁面同一份）
  useEffect(() => {
    let on = true
    fetchRolling(curSlot).then((d) => on && setRolling(d)).catch(() => on && setRolling(null))
    return () => { on = false }
  }, [curSlot, demoOn, demoDay, season, rev])

  /** 套用新的條件：條件沒變的設備沿用基準的預估（日前排程排的），照建議的用建議時間
      （洗衣機、烘衣機只有一台照建議時，和另一台的條件接得上才用；接不上的原因顯示在那台底下），
      其他依電價估；再重算電費 */
  const apply = (c) => {
    const base = loaded.current
    if (!base || !schedule || !plan) return
    const same = (ids) => ids.every((id) => JSON.stringify(c[id]) === JSON.stringify(base.cond[id]))
    let starts = estimateWithRec(c, plan.price, base.rec)
    const all = same(SHIFT_IDS)
    if (!all && SHIFT_IDS.every((id) => followsRec(c, id) && base.rec?.[id] != null)) {
      starts = { ...base.rec } // 三台都照建議：就是建議時間本身（三台一起排的解），沒改的那台也不沿用基準的預估
    } else {
      if (same(['dishwasher'])) starts.dishwasher = base.starts.dishwasher
      if (same(['washer', 'dryer'])) Object.assign(starts, { washer: base.starts.washer, dryer: base.starts.dryer })
    }
    const rows = { ...schedule, ...rowsOf(starts) }
    if (cond && condKey(c) !== condKey(cond)) setPrefsMsg('') // 條件改了：上一次「已送出」的訊息不再適用
    setCond(c)
    setEst(starts)
    setSchedule(rows)
    if (all) setPlan(base.plan)
    // 切換情境的瞬間，舊情境的重算晚一步回來時不能蓋掉新的
    else recomputeSchedule(rows, planDay).then((p) => p.season === getScenario().season && setPlan(p))
  }
  const change = (id, patch) => apply({ ...cond, [id]: { ...cond[id], ...patch } })
  const allOff = () => apply(defaultCond())
  const allRec = () => apply(recommendCond())
  const follow = (id) => apply({ ...cond, [id]: recCond(id) })
  const pickMode = (m) => {
    if (m !== mode) setPrefsMsg('')
    setMode(m)
  }
  const undo = () => {
    if (!loaded.current) return
    setMode(loaded.current.mode)
    apply(loaded.current.cond)
  }
  const dirty = Boolean(cond) && (condKey(cond) !== sent || mode !== sentMode)
  // 23:45 起隔日的日前排程已排定：條件鎖住到午夜，午夜後換成規劃下一天
  const closed = curSlot >= PLAN_CUTOFF_SLOT
  // 條件的問題（⛔ 擋送出、⚠️ 提醒），加上照建議的設備為什麼預估時間不是建議時間
  const problems = useMemo(() => (cond
    ? [...checkCond(cond), ...Object.entries(recClash(cond, rec)).map(([devId, text]) => ({ devId, level: 'warn', text }))]
    : []), [cond, rec])

  // 照建議排的電費，以及指定時間的設備比建議時間多花多少。都用 recomputeSchedule 算，
  // 和上面「預估電費」同一套算法（電池照原排程），比起來才公平。
  // 照建議排的電費有日前排程另外算的 MILP 解（設備和電池一起排）就用那個，不另外試算
  useEffect(() => {
    if (!schedule || !cond || !rec || !planDay) return undefined
    let on = true
    const moved = SHIFT_IDS.filter((id) => cond[id].mode === 'fixed' && rec[id] != null && est?.[id] != null && est[id] !== rec[id])
    const milp = loaded.current?.recCost ?? null
    ;(async () => {
      const cur = await recomputeSchedule(schedule, planDay)
      const all = milp == null ? await recomputeSchedule({ ...schedule, ...rowsOf(rec) }, planDay) : null
      const diffs = {}
      for (const id of moved) {
        const alt = await recomputeSchedule({ ...schedule, [id]: rowsOf({ [id]: rec[id] })[id] }, planDay)
        const d = +(cur.summary.optimizedCost - alt.summary.optimizedCost).toFixed(1)
        diffs[id] = Math.abs(d) < 0.05 ? 0 : d
      }
      if (on) setCmp({ recCost: all?.summary.optimizedCost ?? null, diffs })
    })().catch(() => on && setCmp(null))
    return () => { on = false }
  }, [schedule, cond, rec, est, planDay])

  /** 重排：送出條件，本機從隔日起重排（電量一天接一天，之後幾天也會變），今天以前不動。
      常駐排程＝隔日起每天都照這個排；明日排程＝只管隔日，後天照常駐排程 */
  const submit = async () => {
    if (!cond || closed) return
    const c = cond
    const m = mode
    const starts = est
    setSending(true)
    const r = await savePrefs(toPrefs(c), planDay, m)
    setSending(false)
    if (r.saved === 'cloud') {
      setSent(condKey(c))
      setSentMode(m)
      // 送出的條件成為新的基準：「復原更改」回到送出的條件
      if (loaded.current) {
        loaded.current = { ...loaded.current, cond: c, mode: m, starts, source: 'price', plan: planRef.current ?? loaded.current.plan }
      }
      setPrefsMsg(m === 'standing'
        ? `已送出常駐排程：${md(planDay)} 起每天照這個排，算好後這頁會自動更新。`
        : `已送出明日排程：只排 ${md(planDay)}，算好後這頁會自動更新。`)
    } else {
      setPrefsMsg(`沒有送出：${r.error ?? '未設定雲端金鑰'}`)
    }
  }

  /* ---- 在甘特圖上拖動可轉移設備＝指定時間 ----
     按住設備那一列：按在原本的運轉段上就整段拖著走，按在別處就從那一格開始；放開後改成「指定時間」。
     一次運轉的長度固定；超出一天、或烘衣機超過 22:00 的，自動往前靠。拖到一半按 Esc 可以放棄。 */
  const [drag, setDrag] = useState(null) // { devId, grab, start, inside, moved, clamped }
  const dragRef = useRef(null)
  const place = (devId, raw) => {
    const s = Math.max(0, Math.min(latestStart(devId), raw))
    return { start: s, clamped: s !== raw }
  }
  const dragHint = drag
    ? `指定 ${nameOf(drag.devId)}　${hm(drag.start)}～${hm(drag.start + durOf(drag.devId))}`
    : null

  const commitDrag = (d) => {
    if (d.inside && !d.moved) return // 按一下原本的運轉段：不改
    if (d.clamped) {
      setNotice(`⚠️ ${nameOf(d.devId)}要在 ${hm(latestStart(d.devId) + durOf(d.devId))} 前跑完，改從 ${hm(d.start)} 開始`)
    }
    change(d.devId, { mode: 'fixed', start: d.start })
  }

  const startDrag = (e, devId, slot) => {
    if (closed) { e.preventDefault(); return } // 已截止：不能拖，也不要拖出一片反白的文字
    if (!schedule || !cond || e.button > 0) return // 滑鼠右鍵、中鍵不算
    e.preventDefault() // 拖曳時不要選取到文字
    const cur = est?.[devId]
    const inside = cur != null && slot >= cur && slot < cur + durOf(devId)
    const grab = inside ? slot - cur : 0
    const d = { devId, grab, inside, moved: false, ...place(devId, slot - grab) }
    dragRef.current = d
    setDrag(d)

    // 監聽在按下的當下就掛上，不能等 useEffect：手指很快點一下時「放開」可能比監聽先發生。
    // 手指拖曳時 pointer 事件會一直送給按下的那一格，所以用座標找出現在停在哪一格；只認同一台設備那一列
    const move = (ev) => {
      const c = dragRef.current
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('td[data-slot]')
      if (!c || !cell || cell.dataset.dev !== c.devId) return
      const next = place(c.devId, Number(cell.dataset.slot) - c.grab)
      if (next.start === c.start) return
      dragRef.current = { ...c, ...next, moved: true }
      setDrag(dragRef.current)
    }
    const finish = (commit) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc)
      const c = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (commit && c) commitDrag(c)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const esc = (ev) => ev.key === 'Escape' && finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc)
  }

  // ---- 電力供需與電池調度（隔日） ----
  const supplyOption = useMemo(() => {
    if (!plan) return {}
    return {
      tooltip: { ...baseTooltip, formatter: powerSocFormatter },
      color: ['#ffb020', '#f97316', '#3b82f6', TEXT_MAIN, COLORS.battery],
      // 三個供電來源畫成面積（線寬 0），圖例預設只剩一個小圓點，指定成方塊才和面積對得上
      legend: {
        ...baseLegend,
        data: [
          { name: '太陽能供電', icon: 'roundRect' },
          { name: '電池放電', icon: 'roundRect' },
          { name: '電網供電', icon: 'roundRect' },
          '總負載',
          'SOC',
        ],
      },
      ...powerSocLayout(),
      yAxis: [valueYAxis('kW'), socYAxis()],
      series: [
        { name: '太陽能供電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(255,176,32,0.7)' }, data: plan.pvToLoad,
          markArea: touMarkArea(plan.tier, plan.price) },
        { name: '電池放電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(249,115,22,0.7)' }, data: plan.battToLoad },
        { name: '電網供電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(59,130,246,0.6)' }, data: plan.gridToLoad },
        { name: '總負載', type: 'line', symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: TEXT_MAIN, type: 'dashed' }, data: plan.load },
        { name: 'SOC', type: 'line', xAxisIndex: 1, yAxisIndex: 1, symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: COLORS.battery }, data: plan.socPct,
          markArea: touMarkArea(plan.tier, plan.price, undefined, { label: false }) },
      ],
    }
  }, [plan, theme])

  // ---- 未來 24 小時預測與排程（和主頁面同一張） ----
  const hasRolling = Boolean(rolling && rolling.source !== 'none' && rolling.season === season)
  const next24Option = useMemo(() => (hasRolling ? rollingOption(rolling) : {}), [rolling, hasRolling, theme])

  const s = plan?.summary
  const milpRec = loaded.current?.recCost ?? null

  if (!planDay) {
    return (
      <Panel>
        <p>今天是展示月的最後一天，沒有隔日可以規劃。</p>
      </Panel>
    )
  }

  return (
    <>
      {/* 結果摘要（隔日） */}
      <div className="grid cols-6">
        <Tile label="預估電費" value={s ? s.optimizedCost : '—'} unit="元" />
        <Tile label="預估省電費" value={s ? s.savings : '—'} unit="元" color={COLORS.save} />
        <Tile label="太陽能自用率" value={s ? s.selfUseRate : '—'} unit="%" color={COLORS.solar} />
        <Tile label="向電網購電" value={s ? s.gridImportKwh : '—'} unit="度" color={COLORS.grid} />
        <Tile label="太陽能充電" value={s ? s.pvToBattKwh : '—'} unit="度" color={COLORS.battery} />
        <Tile label="電池放電量" value={s ? s.dischargeKwh : '—'} unit="度" color={COLORS.discharge} />
      </div>

      {/* 供需調度 */}
      <Panel title={`電力供需與電池調度（${md(planDay)}）`} className="mt-16">
        <EChart option={supplyOption} height={330 + SOC_EXTRA_HEIGHT} label="隔日電力供需：太陽能、電池、電網供電堆疊與 SOC" />
      </Panel>

      {/* 未來 24 小時預測與排程（實時運轉層每 15 分鐘重排的計畫） */}
      <Panel title="未來 24 小時預測與排程" className="mt-16">
        {hasRolling
          ? <EChart option={next24Option} height={380 + socExtraHeight(PLAN_SOC_H)}
              label="未來 24 小時預測與排程：從現在起 24 小時的太陽能、負載、電網、電池功率與 SOC" />
          : <div className="skeleton" style={{ height: 380 + socExtraHeight(PLAN_SOC_H) }} />}
      </Panel>

      {/* 用戶規劃：可轉移設備的條件（常駐排程／明日排程；在下面的甘特圖上拖動＝指定時間） */}
      <DevicePrefs
        cond={cond}
        est={est}
        rec={rec}
        recCost={milpRec ?? cmp?.recCost ?? null}
        curCost={s?.optimizedCost ?? null}
        diffs={cmp?.diffs}
        date={planDay}
        closed={closed}
        mode={mode}
        onMode={pickMode}
        dirty={dirty}
        busy={computing || sending}
        sending={sending}
        waiting={waitHere}
        msg={prefsMsg}
        problems={problems}
        onChange={change}
        onFollow={follow}
        onAllOff={allOff}
        onAllRec={allRec}
        onUndo={undo}
        onSubmit={submit}
      />

      {/* 可轉移設備運行時段甘特 */}
      <Panel
        title="各設備運行時段"
        right={(dragHint || notice)
          ? <span className="hint plan-notice" role="status" aria-live="polite">{dragHint || notice}</span>
          : null}
        className="mt-16"
      >
        {schedule && plan ? (
          <>
            {/* 手機上表格比螢幕寬、要左右捲動：tabIndex 讓鍵盤也能選到這個區塊再用方向鍵捲 */}
            <div className="gantt" tabIndex={0} role="region" aria-label="各設備運行時段表，可左右捲動">
              <table>
                <thead>
                  <tr>
                    <th className="dev-name" style={{ textAlign: 'left' }}>設備</th>
                    {HOURS.map((h) => (
                      <th key={h} colSpan={4}>{pad2(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SHIFTABLE.map((dev) => (
                    <tr key={dev.id}>
                      <td className="dev-name">
                        <span style={{ marginRight: 6 }}>{dev.icon}</span>
                        {dev.name}
                      </td>
                      {schedule[dev.id].map((on, slot) => {
                        const peak = plan.tier[slot] === 'peak'
                        // 拖曳中：這一台照放開後的位置顯示
                        const dragging = drag?.devId === dev.id
                        const inDrag = dragging && slot >= drag.start && slot < drag.start + durOf(dev.id)
                        const shownOn = dragging ? inDrag : on
                        const cls = closed ? ['cell'] : ['cell', 'editable'] // 截止後不能拖
                        if (peak) cls.push('peak-bg')
                        if (shownOn) cls.push('on', 'shiftable')
                        if (shownOn && !dragging && cond?.[dev.id]?.mode === 'auto') cls.push('est')
                        const r = rec?.[dev.id]
                        const inRec = r != null && slot >= r && slot < r + durOf(dev.id)
                        if (inRec && !shownOn) cls.push('rec')
                        if (inDrag) cls.push('painting')
                        if (!hardOk(dev.id, slot)) cls.push('blocked')
                        else if (!inDefault(dev.id, slot)) cls.push('outside')
                        const note = !hardOk(dev.id, slot) ? '（22:00 以後不能運轉）'
                          : !inDefault(dev.id, slot) ? '（建議範圍外，可以指定）'
                          : inRec ? '（建議時間）'
                          : ''
                        return (
                          <td
                            key={slot}
                            className={cls.join(' ')}
                            data-dev={dev.id}
                            data-slot={slot}
                            title={`${dev.name}｜${slotToTime(slot)}｜${peak ? '尖峰' : '離峰'}${note}`}
                            onPointerDown={(e) => startDrag(e, dev.id, slot)}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="legend mt-16">
              <span className="item"><span className="swatch" style={{ background: '#3b82f6' }} /> 指定時間</span>
              <span className="item"><span className="swatch est-swatch" /> 系統決定（預估）</span>
              <span className="item"><span className="swatch" style={{ background: 'rgba(239,68,68,0.18)' }} /> 尖峰時段</span>
              <span className="item"><span className="swatch rec-swatch" /> 建議時間</span>
              <span className="item"><span className="swatch outside-swatch" /> 建議範圍外</span>
              <span className="item"><span className="swatch blocked-swatch" /> 烘衣機 22:00 後不能運轉</span>
            </div>
          </>
        ) : (
          <div className="skeleton" style={{ height: 200 }} />
        )}
      </Panel>
    </>
  )
}

