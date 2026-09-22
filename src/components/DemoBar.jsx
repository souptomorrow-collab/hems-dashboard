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
   只留日期、暫停／繼續；進到那頁時播放會先暫停，拖甘特圖時隔日才不會跟著換掉 */
export default function DemoBar({ monthOnly = false, history = false }) {
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
    if (!demo.enabled || monthOnly) return
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
  }, [demo.enabled, monthOnly])

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
          onChange={(e) => e.target.value && seekDemoDay(+e.target.value.slice(8, 10) - 1)}
        />
      </label>
      <span className="demo-wk">（{wk(today)}）</span>
      <button className="demo-btn" onClick={() => seekDemoDay(demo.day + 1)} disabled={demo.day >= days - 1} title="後一天">›</button>
    </div>
  )
  const playBtn = (
    <button className="demo-btn" onClick={togglePlay} title={demo.playing ? '暫停' : '繼續'}>
      {demo.playing ? '⏸' : '▶'}
    </button>
  )

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
      ) : monthOnly ? (
        <>
          {playBtn}
          {dayPicker}
          <span className="hint demo-note">
            {history
              ? `今天 ${md(today)}，歷史紀錄是展示月到昨天為止的實時運轉結果・按 ‹ › 換天`
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
            <strong>{demo.speed <= 300 ? hms(demo.sec) : slotToTime(demo.slot)}</strong>
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

          <span className="hint demo-note">{speed.hint}・空白鍵暫停、← → 前後一格、PageUp／PageDown 前後一天</span>
        </>
      )}
      {watchChip}
    </div>
  )
}
