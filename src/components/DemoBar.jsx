/* ============================================================
   展示模式控制列

   期末口試沒辦法站在台上等一整天，這條列子把一天壓縮成 96 秒播完
   （15 分鐘 = 1 秒）。它只負責操作 lib/demoClock.js 的虛擬時鐘，
   畫面本身不特別處理——整個 UI 的即時區塊都是由時鐘推導的，
   時鐘一加速，能源流向、KPI、設備開關、尖離峰標示就一起動起來。
   ============================================================ */
import { useEffect, useState } from 'react'
import { fetchWatcherStatus } from '../api/forecastData.js'
import {
  useDemoClock,
  getDemo,
  toggleDemo,
  togglePlay,
  restartDemo,
  seekDemo,
  setSpeed,
  SPEEDS,
} from '../lib/demoClock.js'
import { SLOTS_PER_DAY, slotToTime } from '../lib/constants.js'
import { useScenario, SEASONS } from '../lib/scenario.js'

const md = (date) => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`
const p2 = (n) => String(n).padStart(2, '0')
const hms = (s) => `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`

/* 本機排程程式（watch_prefs.py）：網頁叫不動電腦裡的程式，所以在這台電腦註冊了 hems-watch:// 連結
   （device_plan/scripts/register_protocol.py）。按下展示模式時它沒在跑，就開這個連結，
   瀏覽器問過之後在背景叫起它；已經在跑的不會開第二份。沒註冊的電腦按了不會有反應。 */
const WATCH_URL = 'hems-watch://start'

/* monthOnly：用電規劃頁只要開關（隔日規劃不看今天播到哪），不顯示播放控制 */
export default function DemoBar({ monthOnly = false }) {
  const demo = useDemoClock()
  const speed = SPEEDS.find((s) => s.key === demo.speed) ?? SPEEDS[0]
  const { season } = useScenario()
  const show = (SEASONS.find((s) => s.key === season) ?? SEASONS[0]).dataset
  const month = `2010 年 ${+show.slice(5, 7)} 月`

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
  const launch = () => {
    window.location.href = WATCH_URL
    setLaunchedAt(Date.now())
  }
  // 開啟展示模式時，本機排程程式沒在跑就順便叫起來（要在按鈕的點擊裡做，瀏覽器才允許開外部程式）
  const onPower = () => {
    if (!demo.enabled && watcher && !watcher.running) launch()
    toggleDemo()
  }
  const watchChip = watcher && (
    <span
      className={`watch-chip ${watcher.running ? 'ok' : 'off'}`}
      role="status"
      title={watcher.running
        ? `本機的 watch_prefs.py 在跑，${watcher.age_s ?? '?'} 秒前回報`
        : '本機的 watch_prefs.py 沒有在跑：使用者改設定後不會重排。按「啟動」叫起來（這台電腦要先執行過 register_protocol.py）'}
    >
      {watcher.running
        ? (watcher.state === 'computing' ? `本機排程：重算中${watcher.job ? `（${watcher.job}）` : ''}` : '本機排程：運作中')
        : (Date.now() - launchedAt < 60000 ? '本機排程：啟動中…' : '本機排程：沒有在跑')}
      {!watcher.running && <button className="btn-link" onClick={launch}>啟動</button>}
    </span>
  )

  // 展示時用鍵盤操作，口試講解時不必回頭找滑鼠：
  // 空白鍵暫停／繼續、← → 前後一格（按住 Shift 一次一小時）、Home 回到 00:00
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
      else if (e.key === 'Home') restartDemo()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demo.enabled, monthOnly])

  return (
    <div className={`demo-bar ${demo.enabled ? 'on' : ''}`}>
      <button
        className={`demo-power ${demo.enabled ? 'on' : ''}`}
        onClick={onPower}
        title={demo.enabled ? '關閉展示模式，回到真實時間' : `開啟展示模式：顯示 ${month}整月排程與實時運轉`}
      >
        {demo.enabled ? '⏹ 結束展示' : '▶ 展示模式'}
      </button>

      {!demo.enabled ? (
        <span className="hint demo-idle">
          {`目前照真實時間。開啟後`
            + (monthOnly ? '' : '加速播放（預設 15 分鐘 = 1 秒；要講實時層切到 1 分鐘 = 1 秒），')
            + `頁面最下方顯示 ${month}整月排程與實時運轉（今天是展示日 ${md(show)}）`}
        </span>
      ) : monthOnly ? (
        <span className="hint demo-note">
          {`展示模式：${month}整月排程與實時運轉在頁面最下方（今天是展示日 ${md(show)}，只能調整隔日）`}
        </span>
      ) : (
        <>
          <button className="demo-btn" onClick={togglePlay} title={demo.playing ? '暫停' : '繼續'}>
            {demo.playing ? '⏸' : '▶'}
          </button>
          <button className="demo-btn" onClick={restartDemo} title="從 00:00 重播">
            ⟲
          </button>

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
            aria-label="播放進度"
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

          <span className="hint demo-note">{speed.hint}・空白鍵暫停、← → 前後一格</span>
        </>
      )}
      {watchChip}
    </div>
  )
}
