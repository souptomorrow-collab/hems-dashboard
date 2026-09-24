/* ============================================================
   展示模式控制列

   期末口試沒辦法站在台上等一整個月，這條列子把展示月加速播完：
   從月初 00:00 開始，一天接一天播到月底（預設 15 分鐘 = 1 秒；1 天/10 秒約 5 分鐘播完整月）。
   它只負責操作 lib/demoClock.js 的虛擬時鐘，畫面本身不特別處理——整個 UI 的即時區塊都是由時鐘推導的，
   時鐘一加速，能源流向、KPI、設備開關、尖離峰標示就一起動起來；換天時各頁換成那一天的資料，
   用電規劃能調整的隔日也跟著走。
   ============================================================ */
import { useEffect, useState } from 'react'
import { fetchWatcherStatus } from '../api/forecastData.js'
import { pingDemo } from '../api/prefs.js'
import {
  useDemoClock,
  getDemo,
  startDemo,
  stopDemo,
  togglePlay,
  restartDemo,
  seekDemo,
  seekDemoDay,
  setSpeed,
  atMonthEnd,
  SPEEDS,
} from '../lib/demoClock.js'
import { SLOTS_PER_DAY, slotToTime } from '../lib/constants.js'
import { useScenario, useScenarioDays, monthLengthOf, SEASONS } from '../lib/scenario.js'

const WEEK = '日一二三四五六'
const md = (date) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`
const wk = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return WEEK[new Date(y, m - 1, d).getDay()]
}
const p2 = (n) => String(n).padStart(2, '0')
const hms = (s) => `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`

/* 本機排程程式（watch_prefs.py）：網頁叫不動電腦裡的程式，所以放程式的那台電腦登入時會先跑一個
   待命程式（device_plan/scripts/demo_agent.py）。展示模式開著時網頁每分鐘送一次「還在展示」（POST /wake，
   Layout 負責送），待命程式看到就叫起監看程式，30 分鐘沒人展示就關掉——在哪一台電腦按都一樣。
   待命程式沒在跑時，「啟動」退回用 hems-watch:// 連結（只在註冊過的那台電腦有效，見 register_protocol.py）。 */
const WATCH_URL = 'hems-watch://start'

/* monthOnly：用電規劃頁不需要時段的進度條與速度（隔日規劃不看今天播到幾點），
   只留日期、暫停／繼續；進到那頁時播放會先暫停，拖甘特圖時隔日才不會跟著換掉
   compact：系統資訊頁用的精簡版，只在展示中出現：結束、暫停／繼續、目前播到哪（頁首時鐘照展示時間在走，
   這頁卻沒有控制列的話，講系統設定時停不下來）。換天、拖時段、快捷鍵都回主頁面操作 */
export default function DemoBar({ monthOnly = false, history = false, compact = false }) {
  const demo = useDemoClock()
  const speed = SPEEDS.find((s) => s.key === demo.speed) ?? SPEEDS[0]
  const { season } = useScenario()
  const { today, next } = useScenarioDays()
  const show = (SEASONS.find((s) => s.key === season) ?? SEASONS[0]).dataset
  const month = `2010 年 ${+show.slice(5, 7)} 月`
  const days = monthLengthOf(season)
  const monthStart = `${show.slice(0, 7)}-01`
  const monthEnd = `${show.slice(0, 7)}-${p2(days)}`

  // 本機排程程式的狀態：平常每 10 秒查一次，剛叫過的一分鐘內每 3 秒查一次
  const [watcher, setWatcher] = useState(null) // null＝不知道（沒有後端 API 或讀不到）
  const [launchedAt, setLaunchedAt] = useState(0)
  useEffect(() => {
    let on = true
    const check = () => fetchWatcherStatus().then((w) => on && setWatcher(w)).catch(() => on && setWatcher(null))
    check()
    const fast = Date.now() - launchedAt < 60000
    const id = setInterval(check, fast ? 3000 : 10000)
    const back = fast ? setTimeout(() => setLaunchedAt(0), 60000) : null
    return () => { on = false; clearInterval(id); if (back) clearTimeout(back) }
  }, [launchedAt])
  // 手動「啟動」：送喚醒訊號給待命程式；待命程式也沒在跑，才退回 hems-watch:// 連結（要在點擊裡做，瀏覽器才允許）
  const launch = () => {
    pingDemo()
    if (!watcher?.agent) window.location.href = WATCH_URL
    setLaunchedAt(Date.now())
  }
  // 開啟展示模式：從月初開始（用電規劃頁先不播）。「還在展示」的訊號由 Layout 每分鐘送，
  // 待命程式收到就叫起監看程式；這裡只是接下來一分鐘查快一點，狀態早點變成「運作中」
  const onPower = () => {
    if (demo.enabled) {
      stopDemo()
      return
    }
    startDemo({ days, day: 0, play: !monthOnly })
    setLaunchedAt(Date.now())
  }
  const watchChip = watcher && (
    <span
      className={`watch-chip ${watcher.running ? 'ok' : watcher.agent ? 'idle' : 'off'}`}
      role="status"
      title={watcher.running
        ? `本機的 watch_prefs.py 在跑，${watcher.age_s ?? '?'} 秒前回報`
        : watcher.agent
          ? '放程式的電腦開著、待命中：開展示模式（或按「啟動」）就會叫起排程監看，30 分鐘沒人展示會自己關掉'
          : '放程式的電腦上待命程式沒在跑（電腦關機、睡眠，或還沒執行 install_agent.py）。在那台電腦上按「啟動」會用 hems-watch:// 叫起來'}
    >
      {watcher.running
        ? (watcher.state === 'computing' ? `本機排程：重算中${watcher.job ? `（${watcher.job}）` : ''}` : '本機排程：運作中')
        : Date.now() - launchedAt < 60000 || (demo.enabled && watcher.agent)
          ? '本機排程：啟動中…'
          : watcher.agent ? '本機排程：待命中' : '本機排程：沒有在跑'}
      {!watcher.running && <button className="btn-link" onClick={launch}>啟動</button>}
    </span>
  )

  // 展示時用鍵盤操作，口試講解時不必回頭找滑鼠：
  // 空白鍵暫停／繼續、← → 前後一格（按住 Shift 一次一小時）、PageUp／PageDown 前後一天、Home 回到月初
  useEffect(() => {
    if (!demo.enabled || monthOnly || compact) return
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const tag = e.target?.tagName
      // 在輸入框、下拉選單裡打字不要攔；空白鍵在按鈕上本來就會按下去，也不要重複觸發
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable) return
      if (e.key === ' ' && ['BUTTON', 'A'].includes(tag)) return
      const step = e.shiftKey ? 4 : 1
      if (e.key === ' ') togglePlay()
      else if (e.key === 'ArrowRight') seekDemo(getDemo().slot + step)
      else if (e.key === 'ArrowLeft') seekDemo(getDemo().slot - step)
      else if (e.key === 'PageDown') seekDemoDay(getDemo().day + 1)
      else if (e.key === 'PageUp') seekDemoDay(getDemo().day - 1)
      else if (e.key === 'Home') restartDemo()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demo.enabled, monthOnly, compact])

  // 日期欄：只接受展示月裡完整的日期。原本只取「日」那兩位，打 2010-08-05 會直接跳到 7/5；
  // 在欄位裡改年或月（日期其實沒變）也會把時間重設到 00:00。月外的日期不動、提示幾秒，欄位回到播放中的那天
  const [dayNote, setDayNote] = useState('')
  useEffect(() => {
    if (!dayNote) return undefined
    const id = setTimeout(() => setDayNote(''), 4000)
    return () => clearTimeout(id)
  }, [dayNote])
  const pickDay = (value) => {
    if (!value) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < monthStart || value > monthEnd) {
      setDayNote(`只能選 ${md(monthStart)}～${md(monthEnd)}`)
      return
    }
    setDayNote('')
    if (value !== today) seekDemoDay(+value.slice(8, 10) - 1) // 同一天（改了一段又改回來）不重設時間
  }

  // 播放中的日期：可以直接選一天跳過去，或前後一天
  const dayPicker = (
    <div className="demo-day">
      <button className="demo-btn" onClick={() => seekDemoDay(demo.day - 1)} disabled={demo.day <= 0} title="前一天">‹</button>
      <label>
        <span className="sr-only">播到哪一天</span>
        <input
          id="demo-day"
          type="date"
          value={today}
          min={monthStart}
          max={monthEnd}
          onChange={(e) => pickDay(e.target.value)}
        />
      </label>
      <span className="demo-wk">（{wk(today)}）</span>
      <button className="demo-btn" onClick={() => seekDemoDay(demo.day + 1)} disabled={demo.day >= days - 1} title="後一天">›</button>
      <span className="demo-day-note" role="status">{dayNote}</span>
    </div>
  )
  // 播完整個月會停在月底最後一秒；這時按 ▶（或空白鍵）從月初重播（見 demoClock.js 的 togglePlay）
  const ended = !demo.playing && atMonthEnd(demo)
  const playBtn = (
    <button className="demo-btn" onClick={togglePlay} title={demo.playing ? '暫停' : ended ? '播完了：從月初重播' : '繼續'}>
      {demo.playing ? '⏸' : '▶'}
    </button>
  )
  const clockText = demo.speed <= 300 ? hms(demo.sec) : slotToTime(demo.slot)

  // 系統資訊頁的精簡版只在展示中出現（Layout 也只在展示中放），結束展示的那一刻就收起來
  if (compact && !demo.enabled) return null

  return (
    <div className={`demo-bar ${demo.enabled ? 'on' : ''}`}>
      <button
        className={`demo-power ${demo.enabled ? 'on' : ''}`}
        onClick={onPower}
        title={demo.enabled ? '關閉展示模式，回到真實時間' : `開啟展示模式：從 ${md(monthStart)} 起播完 ${month}`}
      >
        {demo.enabled ? '⏹ 結束展示' : '▶ 展示模式'}
      </button>

      {!demo.enabled ? (
        <span className="hint demo-idle">
          {`目前是今天、全部模擬。開啟後換成專題的實際資料：從 ${md(monthStart)} 起一天一天播完 ${month}`
            + '（RF／LSTM 預測、MILP 排程、實時運轉），今天跟著播放走、能調整的隔日也跟著走'}
        </span>
      ) : compact ? (
        <>
          {playBtn}
          <div className="demo-time">
            <strong>{clockText}</strong>
            <span className="muted">{md(today)}（{wk(today)}）</span>
          </div>
          <span className="hint demo-note">
            {ended
              ? '播完整個月了：按 ▶ 從月初重播'
              : `${demo.playing ? '展示播放中' : '展示已暫停'}：頁首的時鐘與電價照展示時間走，本頁的系統設定不受影響・換天、拖時段請回主頁面`}
          </span>
        </>
      ) : monthOnly ? (
        <>
          {playBtn}
          {dayPicker}
          <span className="hint demo-note">
            {history
              ? `今天 ${md(today)}，歷史紀錄是展示月到昨天為止的實時運轉結果（月底播到 23:45 以後含當天）・按 ‹ › 換天`
              : <>{next ? `今天 ${md(today)}，只能調整隔日 ${md(next)}` : '播到月底了，沒有隔日可以調整'}
                ・進到這頁會先暫停，調整完按 ▶ 繼續</>}
          </span>
        </>
      ) : (
        <>
          {playBtn}
          <button className="demo-btn" onClick={restartDemo} title="從月初重播">
            ⟲
          </button>

          {dayPicker}

          <div className="demo-time">
            <strong>{clockText}</strong>
            <span className="muted">
              第 {demo.slot + 1} / {SLOTS_PER_DAY} 格
            </span>
          </div>

          {/* 可以直接拖到想講的時段，不必等它播過去 */}
          <input
            className="demo-seek"
            type="range"
            min={0}
            max={SLOTS_PER_DAY - 1}
            value={demo.slot}
            onChange={(e) => seekDemo(+e.target.value)}
            aria-label="今天的播放進度"
          />

          <div className="demo-speeds" title={speed.hint}>
            {SPEEDS.map((s) => (
              <button
                key={s.key}
                className={`demo-btn ${demo.speed === s.key ? 'active' : ''}`}
                onClick={() => setSpeed(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <span className="hint demo-note">
            {ended
              ? '播完整個月了：按 ▶ 或空白鍵從月初重播'
              : `${speed.hint}・空白鍵暫停、← → 前後一格、PageUp／PageDown 前後一天`}
          </span>
        </>
      )}
      {watchChip}
    </div>
  )
}
