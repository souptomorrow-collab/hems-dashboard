import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import EChart from '../components/EChart.jsx'
import Tile from '../components/Tile.jsx'
import { fetchPlanning, recomputeSchedule } from '../api/client.js'
import { DEVICES, COLORS, CATEGORY_LABEL, slotToTime, SLOTS_PER_DAY, BATTERY } from '../lib/constants.js'
import { isAllowedSlot, SHIFTABLE_RULES } from '../lib/simulate.js'
import { checkDevice } from '../lib/deviceCheck.js'
import DevicePrefs from '../components/DevicePrefs.jsx'
import MonthView from '../components/MonthView.jsx'
import { toRow } from '../api/prefs.js'
import { useScenario, getScenario, SEASONS, nextDayOf } from '../lib/scenario.js'
import { refreshCached, fetchSchedules } from '../api/forecastData.js'
import { PREFS_SAVED } from '../api/prefs.js'
import { useDemoEnabled } from '../lib/demoClock.js'
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

export default function Planning() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const admin = useIsAdmin()
  const [plan, setPlan] = useState(null)
  const [schedule, setSchedule] = useState(null)
  const [computing, setComputing] = useState(false)
  // 演算法給的最佳排程。手動調整只改 plan／schedule，這份留著供「還原」使用
  const [optimal, setOptimal] = useState(null)
  const [edits, setEdits] = useState(0) // 手動改過幾格；0 = 目前就是最佳排程
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
  const planDay = nextDayOf(season) // 資料集的隔日（夏月 2010-07-20、非夏月 2010-01-12）
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

  // 進頁面即取得隔日的最佳化排程；切換夏月／非夏月情境時重新規劃，手動調整一併清掉
  useEffect(() => {
    let on = true
    setComputing(true)
    fetchPlanning().then((p) => {
      if (!on) return
      planStamp.current = p.planStamp
      setPlan(p)
      setSchedule(withSaved(p.schedule, savedRef.current))
      setOptimal(p)
      setEdits(0)
      setComputing(false)
    })
    return () => { on = false }
  }, [season, reload, planDay])

  // 還原成演算法給的最佳排程（捨棄手動調整）。
  // 原本這顆是「重新計算最佳化」：重跑同一套固定的模擬、結果完全一樣，
  // 還加了 650 毫秒的假延遲讓它看起來像在算。實際唯一的作用是丟掉手動調整，
  // 所以直接換回一開始存下的那份——瞬間完成，也不假裝在計算。
  // 之後排程組有即時的排程服務時，可以改回真正觸發重新排程。
  const restore = () => {
    if (!optimal) return
    setPlan(optimal)
    setSchedule(optimal.schedule)
    setEdits(0)
  }

  /* ---- 使用者存下來的運轉時段 ----
     可轉移設備什麼時候跑由使用者在下面的甘特圖上拖出來，存在 user_prefs。
     這裡把存下來的時段套回甘特圖，讓使用者看到的和排程實際會跑的一致。
     排程與甘特可能不同步（排程還沒重跑），以使用者存的為準。 */
  const savedRef = useRef(null)

  const withSaved = (sched, devices) => {
    if (!sched || !devices) return sched
    const next = { ...sched }
    for (const [id, p] of Object.entries(devices)) {
      if (!Array.isArray(next[id])) continue
      next[id] = p.enabled === false || !p.slots?.length ? new Array(SLOTS_PER_DAY).fill(false) : toRow(p.slots)
    }
    return next
  }

  const onPrefsLoaded = (devices) => {
    savedRef.current = devices
    setSchedule((cur) => withSaved(cur, devices))
  }

  /** 面板上把某一台清成「不跑」 */
  const clearDevice = (id) => {
    setSchedule((cur) => (cur && Array.isArray(cur[id])
      ? { ...cur, [id]: new Array(SLOTS_PER_DAY).fill(false) }
      : cur))
    setEdits((n) => n + 1)
  }

  /* ---- 手動調整可轉移設備：按住拖曳一段，放開時一次套用 ----
     按下的那一格原本是關就整段打開、原本是開就整段關掉；只點一下（沒拖）就是切換那一格。
     拖曳中只更新畫面上的預覽，放開才重算電池調度與成本，拖的過程不會卡。
     拖過不允許運轉的時段會自動跳過，放開後提示略過了幾格。 */
  const [drag, setDrag] = useState(null) // { devId, from, to, value }
  const dragRef = useRef(null)
  const scheduleRef = useRef(schedule)
  scheduleRef.current = schedule

  /* 拖曳中在提示列顯示「放開後這台會變成幾分鐘」。
     只算真的會套用的格（拖過不允許運轉的時段會被跳過），數字才不會騙人。 */
  const dragHint = (() => {
    if (!drag) return null
    const row = scheduleRef.current?.[drag.devId]
    if (!Array.isArray(row)) return null
    const lo = Math.min(drag.from, drag.to)
    const hi = Math.max(drag.from, drag.to)
    const after = row.map((v, i) =>
      (i >= lo && i <= hi && isAllowedSlot(drag.devId, i) ? drag.value : v))
    const n = after.filter(Boolean).length
    const dev = DEVICES.find((x) => x.id === drag.devId)
    const need = SHIFTABLE_RULES[drag.devId]?.dur
    const diff = need == null || n === need ? ''
      : n < need ? `，還差 ${(need - n) * 15} 分鐘` : `，多了 ${(n - need) * 15} 分鐘`
    return `${drag.value ? '排入' : '取消'} ${dev?.name}　${slotToTime(lo)}~${slotToTime(hi + 1)}`
      + `　放開後共 ${n * 15} 分鐘${need == null ? '' : `（需要 ${need * 15} 分鐘${diff}）`}`
  })()

  const applyRange = (d) => {
    const cur = scheduleRef.current
    if (!d || !cur) return
    const lo = Math.min(d.from, d.to)
    const hi = Math.max(d.from, d.to)
    let changed = 0
    let skipped = 0
    const row = cur[d.devId].map((v, i) => {
      if (i < lo || i > hi) return v
      if (!isAllowedSlot(d.devId, i)) {
        skipped++
        return v
      }
      if (v !== d.value) changed++
      return d.value
    })
    const dev = DEVICES.find((x) => x.id === d.devId)
    if (skipped) {
      setNotice(`⚠️ 已略過 ${skipped} 格不允許運轉的時段（${dev.name}可運轉 ${SHIFTABLE_RULES[d.devId].text}）`)
    }
    if (!changed) return
    const next = { ...cur, [d.devId]: row }
    if (!skipped) {
      const problems = checkDevice(d.devId, next)
      setNotice(problems.length
        ? `${problems[0].level === 'error' ? '⛔' : '⚠️'} ${dev.name}：${problems.map((x) => x.text).join('；')}`
        : '')
    }
    setSchedule(next)
    setEdits((n) => n + changed)
    // 切換情境的瞬間，舊情境的重算可能晚一步才回來，不能蓋掉新情境的結果
    recomputeSchedule(next).then((p) => p.season === getScenario().season && setPlan(p))
  }

  // 這一格在不在使用者要求的範圍內。沒設範圍就一律算在內。
  // hi 比 lo 早代表跨午夜（洗碗機 19:00~隔天 07:00），範圍是頭尾兩段。
  const outsideWanted = (devId, slot) => {
    const p = prefs?.[devId]
    if (!p || p.enabled === false || (!p.earliest && !p.deadline)) return false
    const lo = p.earliest ? slotOfTime(p.earliest) % SLOTS_PER_DAY : 0
    const hi = p.deadline ? slotOfTime(p.deadline, true) : SLOTS_PER_DAY
    return hi < lo ? slot < lo && slot >= hi : slot < lo || slot >= hi
  }

  const startDrag = (e, devId, slot) => {
    const dev = DEVICES.find((d) => d.id === devId)
    if (dev.category !== 'shiftable' || !schedule || e.button > 0) return // 滑鼠右鍵、中鍵不算
    if (!isAllowedSlot(devId, slot)) {
      setNotice(`⛔ ${dev.name}的允許運轉時段是 ${SHIFTABLE_RULES[devId].text}，${slotToTime(slot)} 不能排`)
      return
    }
    e.preventDefault() // 拖曳時不要選取到文字
    const d = { devId, from: slot, to: slot, value: !schedule[devId][slot] }
    dragRef.current = d
    setDrag(d)

    // 監聽在按下的當下就掛上，不能等 useEffect：useEffect 要等畫面更新後才執行，
    // 手指很快點一下時「放開」可能比監聽先發生，拖曳狀態會卡住、畫面停在預覽
    // 手指拖曳時 pointer 事件會一直送給按下的那一格，所以用座標找出現在停在哪一格；
    // 只認同一台設備那一列，拖出這一列就停在最後經過的那一格
    const move = (ev) => {
      const cur = dragRef.current
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('td[data-slot]')
      if (!cur || !cell || cell.dataset.dev !== cur.devId) return
      const s = Number(cell.dataset.slot)
      if (s === cur.to) return
      dragRef.current = { ...cur, to: s }
      setDrag(dragRef.current)
    }
    const finish = (commit) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc)
      const cur = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (commit) applyRange(cur)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const esc = (ev) => ev.key === 'Escape' && finish(false) // 拖到一半按 Esc 可以放棄
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
  // 手動調整過排程時，電費和演算法給的最佳排程差多少（手動改一格就看得出代價）
  const costDiff = s && optimal && edits > 0
    ? +(s.optimizedCost - optimal.summary.optimizedCost).toFixed(1)
    : null
  const costDiffText = costDiff == null
    ? ''
    : costDiff === 0
    ? '和最佳排程相同'
    : `比最佳排程${costDiff > 0 ? '多' : '少'} ${Math.abs(costDiff)} 元`

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
                      ? `電池充放電：排程組的 ${plan.planSource} 排程（資料集 ${plan.planDate}），照下方存下的可轉移設備時段排的。只能調整隔日：改了時段按「儲存給排程」，本機從隔日起重排、今天以前不動，最下方看得到整月的變化`
                      : '洗衣機、烘衣機、洗碗機預設不排入，可在下方自行安排時段')
                  : (admin ? `電池充放電：模擬調度（${plan.planNote ?? '這個情境還沒有排程組的排程'}）` : null)}
              </p>
            )}
          </div>
          <div className="plan-date">
            <div className="muted" style={{ fontSize: 12 }}>
              規劃日（隔日）・{SEASONS.find((x) => x.key === season)?.label}電價
            </div>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              {fmtDate(planDate)}
            </div>
            {awaiting && <div className="hint" role="status" style={{ marginBottom: 8 }}>⏳ 本機正在照新設定重排隔日…</div>}
            <button
              className="btn primary"
              onClick={restore}
              disabled={computing || edits === 0}
              title={edits === 0 ? '目前就是最佳排程；在下方甘特表手動調整後才需要還原' : '捨棄手動調整，回到演算法的最佳排程'}
            >
              ↺ 還原最佳排程
            </button>
            <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
              {edits === 0 ? '目前為最佳排程' : `已手動調整 ${edits} 格`}
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

      {/* 使用者指定的運轉時段：時段本身在下面的甘特圖上拖，這裡顯示摘要並存回雲端 */}
      <DevicePrefs
        schedule={schedule}
        date={planDay}
        monthView={demoOn}
        onClear={clearDevice}
        onLoaded={onPrefsLoaded}
        onSaved={(devices) => { savedRef.current = devices }}
      />

      {/* 設備運行時段甘特 */}
      <Panel
        title="各設備運行時段"
        sub="可轉移設備按住拖曳就是設定運轉時段・隔日 24 小時，15 分鐘為單位"
        right={
          <span className={`hint ${notice || dragHint ? 'plan-notice' : ''}`} role="status" aria-live="polite">
            {dragHint || notice || `✏️ 按住拖曳一次排入或取消一整段（點一下只改一格），放開後${
              plan && plan.planSource !== 'sim' ? '購電與電費即時重算（電池維持原排程）' : '電池與成本即時重算'
            }。排好後到上面按「儲存給排程」`}
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
                          <div className="dev-window">可運轉 {SHIFTABLE_RULES[dev.id].text}</div>
                        )}
                      </td>
                      {schedule[dev.id].map((on, slot) => {
                        const peak = plan.tier[slot] === 'peak'
                        const shiftable = dev.category === 'shiftable'
                        const allowed = isAllowedSlot(dev.id, slot)
                        const editable = shiftable && allowed
                        // 拖曳中：這一格在拖過的範圍內，就先照放開後的結果顯示
                        const inDrag = editable && drag?.devId === dev.id &&
                          slot >= Math.min(drag.from, drag.to) && slot <= Math.max(drag.from, drag.to)
                        const shownOn = inDrag ? drag.value : on
                        const cls = ['cell']
                        if (peak) cls.push('peak-bg')
                        if (shownOn) cls.push('on', shiftable ? 'shiftable' : 'fixed')
                        if (editable) cls.push('editable')
                        if (inDrag) cls.push('painting')
                        if (shiftable && !allowed) cls.push('blocked')
                        const note = editable ? '（可按住拖曳調整）' : shiftable ? '（不在允許運轉的時段）' : ''
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
              <span className="item"><span className="swatch" style={{ background: '#3b82f6' }} /> 可轉移設備運轉</span>
              <span className="item"><span className="swatch" style={{ background: '#a855f7' }} /> 不可轉移設備運轉</span>
              <span className="item"><span className="swatch" style={{ background: 'rgba(239,68,68,0.18)' }} /> 尖峰時段</span>
              <span className="item"><span className="swatch blocked-swatch" /> 可轉移設備不允許運轉的時段</span>
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
