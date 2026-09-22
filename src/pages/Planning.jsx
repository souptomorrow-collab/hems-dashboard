import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import { fetchPlanning, recomputeSchedule } from '../api/client.js'
import { DEVICES, COLORS, CATEGORY_LABEL, slotToTime, SLOTS_PER_DAY, BATTERY } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import DevicePrefs, { deviceStatus } from '../components/DevicePrefs.jsx'
import MonthView from '../components/MonthView.jsx'
import { loadPrefs, savePrefs } from '../api/prefs.js'
import { useScenario, getScenario, SEASONS, useScenarioDays } from '../lib/scenario.js'
import { refreshCached, fetchSchedules } from '../api/forecastData.js'
import { PREFS_SAVED } from '../api/prefs.js'
import { useDemoEnabled, getDemo, togglePlay } from '../lib/demoClock.js'
import {
  SHIFT_IDS, defaultCond, recommendCond, recCond, followsRec, fromPrefs, toPrefs, condKey, estimate, rowsOf,
  startsFromRows, checkCond, durOf, latestStart, hardOk, inDefault, nameOf, hm,
} from '../lib/deviceJobs.js'
import { tomorrow, fmtDate, pad2 } from '../lib/format.js'
import { useTheme } from '../lib/theme.js'
import { useIsAdmin } from '../lib/auth.js'
import {
  valueYAxis,
  baseTooltip,
  baseLegend,
  peakMarkArea,
  powerSocLayout,
  powerSocFormatter,
  socYAxis,
  SOC_EXTRA_HEIGHT,
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK_LINE,
} from '../lib/charts.js'

// 最佳化目標只做「省錢」一種：排程組本學期的範圍就是電費最小化。
// 之前另外設計過「自用率最大」「舒緩夜尖峰」兩種模式，因為不會有對應的
// 演算法實作，留在畫面上會讓人誤以為三種都有做，故一併移除。
const OBJECTIVE = {
  label: '省錢模式',
  desc: '把可轉移設備與電池充電排到最便宜的時段，電費最低',
  descPlan: '電池在離峰與太陽能充足時充電、尖峰時放電，電費最低',
}
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '')
const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export default function Planning() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const admin = useIsAdmin()
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
  const planDate = useMemo(() => tomorrow(), [])
  const { season } = useScenario()
  const demoOn = useDemoEnabled() // 展示模式：最下方多顯示整月排程與實時運轉
  // 資料集的隔日：平常是 2010-07-20、2010-01-12；展示模式跟著播放走，播到月底是 null
  const { next: planDay } = useScenarioDays()
  const [cond, setCond] = useState(null) // 隔日各設備的條件（lib/deviceJobs.js）
  const [sent, setSent] = useState('') // 已送出（或雲端讀到）的條件，判斷有沒有改過
  const loaded = useRef(null) // 載入時的 { cond, starts, source, plan, rec }：「復原更改」與電費比較用
  const [est, setEst] = useState(null) // 各設備預估幾點開（第幾格；不跑是 null）
  const [estSource, setEstSource] = useState('price') // schedule＝日前排程（MILP）、price＝依電價估
  const [rec, setRec] = useState(null) // 建議時間：三台都照建議時各設備幾點開（第幾格）
  const [recSource, setRecSource] = useState('price') // schedule＝日前排程另外算的 MILP 解、price＝依電價估
  const [cmp, setCmp] = useState(null) // { recCost, diffs }：照建議排的電費、指定時間比建議時間多花多少
  const [sending, setSending] = useState(false)
  const [prefsMsg, setPrefsMsg] = useState('')

  // 展示模式播放中進到這頁先暫停：拖甘特圖時隔日不會跟著播放換掉，調整完到上方按 ▶ 繼續
  useEffect(() => {
    if (getDemo().enabled && getDemo().playing) togglePlay()
  }, [])
  const [reload, setReload] = useState(0)
  const planStamp = useRef(null)
  const [awaiting, setAwaiting] = useState(null) // 存下新時段後，等本機把隔日照這一版設定重排

  // 存下新時段後本機會先重排隔日：每 5 秒重讀排程，隔日那份換成新設定就重新載入這頁的規劃
  useEffect(() => {
    const onSaved = (e) => e.detail?.stamp && setAwaiting(e.detail.stamp)
    window.addEventListener(PREFS_SAVED, onSaved)
    return () => window.removeEventListener(PREFS_SAVED, onSaved)
  }, [])
  useEffect(() => {
    if (!awaiting) return undefined
    let on = true
    const t0 = Date.now()
    const tick = async () => {
      if (Date.now() - t0 > 3 * 60 * 1000) { setAwaiting(null); return } // 3 分鐘沒動靜就不等了
      const s = await refreshCached('schedule', fetchSchedules).catch(() => null)
      if (!on || s?.byDate?.[planDay]?.prefs_stamp !== awaiting) return
      setAwaiting(null)
      setReload((n) => n + 1)
    }
    const id = setInterval(tick, 5000)
    tick()
    return () => { on = false; clearInterval(id) }
  }, [awaiting, planDay])

  // 進頁面即取得隔日的規劃與條件；切換情境、換天、本機重排好時重新載入，沒送出的更改一併清掉
  useEffect(() => {
    let on = true
    if (!planDay) return undefined // 展示模式播到月底，沒有隔日可以規劃
    setComputing(true)
    setPrefsMsg('')
    ;(async () => {
      const p = await fetchPlanning(planDay)
      if (!on || !p) return
      planStamp.current = p.planStamp
      let c = defaultCond()
      if (demoOn) {
        const d = await loadPrefs(planDay) // 那天的條件（只管那一天；沒排過用 devices，展示月的假設）
        if (!on) return
        c = fromPrefs(d.devices)
      }
      // 預估時間：展示模式有日前排程就用排程的（MILP 把設備和電池一起排）；平常模式或沒有排程時依電價估
      const fromPlan = demoOn && p.planSource !== 'sim'
      const starts = fromPlan ? startsFromRows(p.schedule) : estimate(c, p.price)
      // 建議時間：展示模式用日前排程另外算的（三台都照建議的 MILP 解）；平常模式或沒有時依電價估
      const recPlan = fromPlan && p.recommended?.start_slot
      const recStarts = recPlan
        ? Object.fromEntries(SHIFT_IDS.map((id) => [id, p.recommended.start_slot[id] ?? null]))
        : estimate(recommendCond(), p.price)
      const rows = { ...p.schedule, ...rowsOf(starts) }
      const cur = fromPlan ? p : await recomputeSchedule(rows, planDay)
      if (!on) return
      loaded.current = { cond: c, starts, source: fromPlan ? 'schedule' : 'price', plan: cur, rec: recStarts }
      setCond(c)
      setSent(condKey(c))
      setEst(starts)
      setEstSource(loaded.current.source)
      setRec(recStarts)
      setRecSource(recPlan ? 'schedule' : 'price')
      setSchedule(rows)
      setPlan(cur)
      setComputing(false)
    })()
    return () => { on = false }
  }, [season, reload, planDay, demoOn])

  /** 套用新的條件：條件沒變的設備沿用載入時的預估（展示模式是排程排的），照建議的用建議時間，
      其他依電價估；再重算電費 */
  const apply = (c) => {
    const base = loaded.current
    if (!base || !schedule || !plan) return
    const same = (ids) => ids.every((id) => JSON.stringify(c[id]) === JSON.stringify(base.cond[id]))
    const starts = estimate(c, plan.price)
    // 洗衣機、烘衣機有先後：兩台都照建議（或另一台不開）才直接用建議時間，否則照上面依電價估的
    const pair = ['washer', 'dryer'].every((id) => followsRec(c, id) || c[id].mode === 'off')
    for (const id of SHIFT_IDS) {
      if (base.rec?.[id] != null && followsRec(c, id) && (id === 'dishwasher' || pair)) starts[id] = base.rec[id]
    }
    if (same(['dishwasher'])) starts.dishwasher = base.starts.dishwasher
    if (same(['washer', 'dryer'])) Object.assign(starts, { washer: base.starts.washer, dryer: base.starts.dryer })
    const rows = { ...schedule, ...rowsOf(starts) }
    const all = same(SHIFT_IDS)
    setCond(c)
    setEst(starts)
    setEstSource(all ? base.source : 'price')
    setSchedule(rows)
    if (all) setPlan(base.plan)
    // 切換情境的瞬間，舊情境的重算晚一步回來時不能蓋掉新的
    else recomputeSchedule(rows, planDay).then((p) => p.season === getScenario().season && setPlan(p))
  }
  const change = (id, patch) => apply({ ...cond, [id]: { ...cond[id], ...patch } })
  const allOff = () => apply(defaultCond())
  const allRec = () => apply(recommendCond())
  const follow = (id) => apply({ ...cond, [id]: recCond(id) })
  const undo = () => loaded.current && apply(loaded.current.cond)
  const dirty = Boolean(cond) && condKey(cond) !== sent
  const problems = useMemo(() => (cond ? checkCond(cond) : []), [cond])

  // 照建議排的電費，以及指定時間的設備比建議時間多花多少。都用 recomputeSchedule 算，
  // 和上面「預估電費」同一套算法（展示模式電池照原排程），比起來才公平
  useEffect(() => {
    if (!schedule || !cond || !rec || !planDay) return undefined
    let on = true
    const moved = SHIFT_IDS.filter((id) => cond[id].mode === 'fixed' && rec[id] != null && est?.[id] != null && est[id] !== rec[id])
    ;(async () => {
      const cur = await recomputeSchedule(schedule, planDay)
      const all = await recomputeSchedule({ ...schedule, ...rowsOf(rec) }, planDay)
      const diffs = {}
      for (const id of moved) {
        const alt = await recomputeSchedule({ ...schedule, [id]: rowsOf({ [id]: rec[id] })[id] }, planDay)
        const d = +(cur.summary.optimizedCost - alt.summary.optimizedCost).toFixed(1)
        diffs[id] = Math.abs(d) < 0.05 ? 0 : d
      }
      if (on) setCmp({ recCost: all.summary.optimizedCost, diffs })
    })().catch(() => on && setCmp(null))
    return () => { on = false }
  }, [schedule, cond, rec, est, planDay])

  /** 送出明天的排法：只管那一天；本機從隔日起重排（電量一天接一天，之後幾天也會變），今天以前不動 */
  const submit = async () => {
    if (!cond) return
    setSending(true)
    const r = await savePrefs(toPrefs(cond), planDay)
    setSending(false)
    if (r.saved === 'cloud') {
      setSent(condKey(cond))
      setPrefsMsg(`已送出。只排 ${md(planDay)} 這一天；本機排程程式重排 ${md(planDay)} 以後的日子（電量一天接一天）、今天以前不動，最下方整月檢視看得到一天一天更新。`)
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
    ? `指定 ${nameOf(drag.devId)}　${hm(drag.start)}～${hm(drag.start + durOf(drag.devId))}　放開後改成指定時間`
    : null

  const commitDrag = (d) => {
    if (d.inside && !d.moved) return // 按一下原本的運轉段：不改
    if (d.clamped) {
      setNotice(`⚠️ ${nameOf(d.devId)}要在 ${hm(latestStart(d.devId) + durOf(d.devId))} 前跑完，改從 ${hm(d.start)} 開始`)
    }
    change(d.devId, { mode: 'fixed', start: d.start })
  }

  const startDrag = (e, devId, slot) => {
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

  // ---- 電力供需與電池調度 ----
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
          markArea: peakMarkArea(plan.tier) },
        { name: '電池放電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(249,115,22,0.7)' }, data: plan.battToLoad },
        { name: '電網供電', type: 'line', stack: 'sup', symbol: 'none', lineStyle: { width: 0 },
          areaStyle: { color: 'rgba(59,130,246,0.6)' }, data: plan.gridToLoad },
        { name: '總負載', type: 'line', symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: TEXT_MAIN, type: 'dashed' }, data: plan.load },
        { name: 'SOC', type: 'line', xAxisIndex: 1, yAxisIndex: 1, symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: COLORS.battery }, data: plan.socPct,
          markArea: peakMarkArea(plan.tier) },
      ],
    }
  }, [plan, theme])

  // ---- 電池充放電 + SOC ----
  const battOption = useMemo(() => {
    if (!plan) return {}
    return {
      tooltip: { ...baseTooltip, formatter: powerSocFormatter },
      color: ['rgba(34,197,94,0.8)', 'rgba(20,184,166,0.8)', 'rgba(249,115,22,0.85)', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能充電', '電網充電', '電池放電', 'SOC'] },
      ...powerSocLayout(),
      yAxis: [valueYAxis('kW'), socYAxis()],
      series: [
        { name: '太陽能充電', type: 'bar', stack: 'b', data: plan.pvToBatt,
          itemStyle: { color: 'rgba(34,197,94,0.8)' } },
        { name: '電網充電', type: 'bar', stack: 'b', data: plan.gridToBatt,
          itemStyle: { color: 'rgba(20,184,166,0.8)' } },
        { name: '電池放電', type: 'bar', stack: 'b', data: plan.dischargeKw.map((v) => -v),
          itemStyle: { color: 'rgba(249,115,22,0.85)' } },
        { name: 'SOC', type: 'line', xAxisIndex: 1, yAxisIndex: 1, symbol: 'none', smooth: true,
          lineStyle: { width: 2, color: COLORS.battery }, data: plan.socPct,
          markArea: peakMarkArea(plan.tier),
          markLine: { silent: true, symbol: 'none', lineStyle: { color: TRACK_LINE, type: 'dashed' },
            label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
            data: [{ yAxis: Math.round(BATTERY.socMax * 100) }, { yAxis: Math.round(BATTERY.socMin * 100) }] } },
      ],
    }
  }, [plan, theme])

  const s = plan?.summary
  // 改了條件後，電費和改之前（載入時／已送出的）差多少
  const base = loaded.current?.plan?.summary
  const costDiff = s && base ? +(s.optimizedCost - base.optimizedCost).toFixed(1) : null
  const costDiffText = costDiff == null || !dirty
    ? ''
    : costDiff === 0
    ? '和改之前相同'
    : `比改之前${costDiff > 0 ? '多' : '少'} ${Math.abs(costDiff)} 元`

  if (!planDay) {
    return (
      <>
        <Panel>
          <p className="hint">展示模式播到月底了，沒有隔日可以調整。到上方展示列換一天，或按 ⟲ 從月初重播。</p>
        </Panel>
        {demoOn && <MonthView />}
      </>
    )
  }

  return (
    <>
      {/* 控制列 */}
      <Panel>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, justifyContent: 'space-between' }}>
          <div>
            <div className="objective">
              <span className="objective-tag">最佳化目標</span>
              {OBJECTIVE.label}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              {plan && plan.planSource !== 'sim' ? OBJECTIVE.descPlan : OBJECTIVE.desc}
            </p>
            {plan && (
              <p className="hint" style={{ marginTop: 4 }}>
                {plan.planSource !== 'sim'
                  ? (admin
                      ? `電池與可轉移設備：排程組的 ${plan.planSource} 日前排程（資料集 ${plan.planDate}），設備和電池一起排，設備時間是預估；實際幾點開由實時層每 15 分鐘重排決定。改條件後按「送出給排程」，本機從隔日起重排、今天以前不動，最下方看得到整月的變化`
                      : '洗衣機、烘衣機、洗碗機設條件就好，幾點開由排程決定')
                  : (admin
                      ? (demoOn
                          ? `電池充放電：模擬調度（${plan.planNote ?? '這一天還沒有排程組的排程'}）`
                          : '平常模式：負載、太陽能、電池與可轉移設備都是模擬的；開啟展示模式才換成專題的實際資料與排程組的排程')
                      : null)}
              </p>
            )}
          </div>
          <div className="plan-date">
            <div className="muted" style={{ fontSize: 12 }}>
              規劃日（隔日）・{SEASONS.find((x) => x.key === season)?.label}電價
            </div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              {demoOn && planDay ? `${fmtDate(parseDay(planDay))}・展示中` : fmtDate(planDate)}
            </div>
            {awaiting && <div className="hint" role="status" style={{ marginBottom: 8 }}>⏳ 本機正在照新設定重排隔日…</div>}
            <button
              className="btn primary"
              onClick={undo}
              disabled={computing || !dirty}
              title={dirty ? '捨棄還沒送出的更改，回到載入時的條件' : '條件沒有改過'}
            >
              ↺ 復原更改
            </button>
            <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
              {dirty ? (demoOn ? '條件改過，還沒送出' : '條件改過') : (demoOn ? '目前是已送出的條件' : '目前都還沒排')}
            </div>
          </div>
        </div>
      </Panel>

      {/* 結果摘要 */}
      <div className="grid cols-6 mt-16">
        <Tile label="預估電費" value={s ? s.optimizedCost : '—'} unit="元" sub={costDiffText} />
        <Tile label="預估省電費" value={s ? s.savings : '—'} unit="元" color={COLORS.save} sub={s ? `省 ${s.savingPct}%` : ''} />
        <Tile label="太陽能自用率" value={s ? s.selfUseRate : '—'} unit="%" color={COLORS.solar} />
        <Tile label="向電網購電" value={s ? s.gridImportKwh : '—'} unit="度" color={COLORS.grid} />
        <Tile label="太陽能充電" value={s ? s.pvToBattKwh : '—'} unit="度" color={COLORS.battery} />
        <Tile label="電池放電量" value={s ? s.dischargeKwh : '—'} unit="度" color={COLORS.discharge} />
      </div>

      {/* 供需調度 */}
      <Panel title="電力供需與電池調度" sub="隔日 24 小時・各供電來源堆疊（紅底為尖峰時段）" className="mt-16">
        <EChart option={supplyOption} height={330 + SOC_EXTRA_HEIGHT} label="隔日電力供需：太陽能、電池、電網供電堆疊與 SOC" />
      </Panel>

      {/* 電池充放電 */}
      <Panel title="電池充放電規劃" sub={`太陽能充電 / 電網充電 / 放電 與 SOC（虛線為 ${Math.round(BATTERY.socMin * 100)}%–${Math.round(BATTERY.socMax * 100)}% 上下限）`} className="mt-16">
        <EChart option={battOption} height={300 + SOC_EXTRA_HEIGHT} label="隔日電池充放電規劃與 SOC" />
      </Panel>

      {/* 隔日可轉移設備的條件（在下面的甘特圖上拖動＝指定時間） */}
      <DevicePrefs
        cond={cond}
        est={est}
        estSource={estSource}
        rec={rec}
        recSource={recSource}
        recCost={cmp?.recCost ?? null}
        curCost={s?.optimizedCost ?? null}
        diffs={cmp?.diffs}
        date={planDay}
        cloud={demoOn}
        dirty={dirty}
        sending={sending}
        msg={prefsMsg}
        problems={problems}
        onChange={change}
        onFollow={follow}
        onAllOff={allOff}
        onAllRec={allRec}
        onSubmit={submit}
      />

      {/* 設備運行時段甘特 */}
      <Panel
        title="各設備運行時段"
        sub="可轉移設備：深藍＝指定時間、淺藍＝系統決定的預估、斜線＝建議時間；按住拖曳＝改成指定時間・隔日 24 小時，15 分鐘為單位"
        right={
          <span className={`hint ${notice || dragHint ? 'plan-notice' : ''}`} role="status" aria-live="polite">
            {dragHint || notice || `✏️ 按住設備那一列拖曳＝指定時間（按在原本的運轉段上就整段拖著走）；放開後${
              plan && plan.planSource !== 'sim' ? '購電與電費即時重算（電池維持原排程）' : '電池與成本即時重算'
            }${demoOn ? '。改好到上面按「送出給排程」' : ''}`}
          </span>
        }
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
                  {DEVICES.map((dev) => (
                    <tr key={dev.id}>
                      <td className="dev-name">
                        <span style={{ marginRight: 6 }}>{dev.icon}</span>
                        {dev.name}
                        <span className={`badge ${dev.category === 'shiftable' ? 'shiftable' : 'fixed'}`}
                          style={{ marginLeft: 8, fontSize: 10, padding: '1px 7px' }}>
                          {CATEGORY_LABEL[dev.category]}
                        </span>
                        {SHIFTABLE_RULES[dev.id] && (
                          <div className="dev-window">建議 {SHIFTABLE_RULES[dev.id].text}</div>
                        )}
                        {dev.category === 'shiftable' && (() => {
                          const st = deviceStatus(cond, dev.id, est?.[dev.id])
                          return <div className={`dev-window status-${st.tone}`}>{st.text}</div>
                        })()}
                      </td>
                      {schedule[dev.id].map((on, slot) => {
                        const peak = plan.tier[slot] === 'peak'
                        const shiftable = dev.category === 'shiftable'
                        // 拖曳中：這一台照放開後的位置顯示
                        const dragging = shiftable && drag?.devId === dev.id
                        const inDrag = dragging && slot >= drag.start && slot < drag.start + durOf(dev.id)
                        const shownOn = dragging ? inDrag : on
                        const cls = ['cell']
                        if (peak) cls.push('peak-bg')
                        if (shownOn) cls.push('on', shiftable ? 'shiftable' : 'fixed')
                        if (shownOn && shiftable && !dragging && cond?.[dev.id]?.mode === 'auto') cls.push('est')
                        const r = shiftable ? rec?.[dev.id] : null
                        const inRec = r != null && slot >= r && slot < r + durOf(dev.id)
                        if (inRec && !shownOn) cls.push('rec')
                        if (shiftable) cls.push('editable')
                        if (inDrag) cls.push('painting')
                        if (shiftable && !hardOk(dev.id, slot)) cls.push('blocked')
                        else if (shiftable && !inDefault(dev.id, slot)) cls.push('outside')
                        const note = !shiftable ? ''
                          : !hardOk(dev.id, slot) ? '（22:00 以後不能運轉）'
                          : !inDefault(dev.id, slot) ? '（建議範圍外，可以指定）'
                          : inRec ? '（建議時間；按住拖曳＝指定時間）'
                          : '（按住拖曳＝指定時間）'
                        return (
                          <td
                            key={slot}
                            className={cls.join(' ')}
                            data-dev={dev.id}
                            data-slot={slot}
                            title={`${dev.name}｜${slotToTime(slot)}｜${peak ? '尖峰' : '離峰'}${note}`}
                            onPointerDown={shiftable ? (e) => startDrag(e, dev.id, slot) : undefined}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="legend mt-16">
              <span className="item"><span className="swatch" style={{ background: '#3b82f6' }} /> 可轉移設備（指定時間）</span>
              <span className="item"><span className="swatch est-swatch" /> 可轉移設備（系統決定・預估）</span>
              <span className="item"><span className="swatch" style={{ background: '#a855f7' }} /> 不可轉移設備運轉</span>
              <span className="item"><span className="swatch" style={{ background: 'rgba(239,68,68,0.18)' }} /> 尖峰時段</span>
              <span className="item"><span className="swatch rec-swatch" /> 建議時間（沒排在這裡時）</span>
              <span className="item"><span className="swatch outside-swatch" /> 建議範圍外（可以指定）</span>
              <span className="item"><span className="swatch blocked-swatch" /> 烘衣機 22:00 後不能運轉</span>
            </div>
          </>
        ) : (
          <div className="skeleton" style={{ height: 360 }} />
        )}
      </Panel>

      {/* 展示模式才顯示整個展示月的日前排程與實時運轉；存下新時段後看得到隔日以後一天一天換成新設定 */}
      {demoOn && <MonthView />}
    </>
  )
}
