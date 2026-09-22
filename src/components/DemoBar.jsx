/* ============================================================
   展示模式控制列

   期末口試沒辦法站在台上等一整天，這條列子把一天壓縮成 96 秒播完
   （15 分鐘 = 1 秒）。它只負責操作 lib/demoClock.js 的虛擬時鐘，
   畫面本身不特別處理——整個 UI 的即時區塊都是由時鐘推導的，
   時鐘一加速，能源流向、KPI、設備開關、尖離峰標示就一起動起來。
   ============================================================ */
import { useEffect } from 'react'
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

/* monthOnly：用電規劃頁只要開關（隔日規劃不看今天播到哪），不顯示播放控制 */
export default function DemoBar({ monthOnly = false }) {
  const demo = useDemoClock()
  const speed = SPEEDS.find((s) => s.key === demo.speed) ?? SPEEDS[0]
  const { season } = useScenario()
  const show = (SEASONS.find((s) => s.key === season) ?? SEASONS[0]).dataset
  const month = `2010 年 ${+show.slice(5, 7)} 月`

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
        onClick={toggleDemo}
        title={demo.enabled ? '關閉展示模式，回到真實時間' : `開啟展示模式：顯示 ${month}整月排程與實時運轉`}
      >
        {demo.enabled ? '⏹ 結束展示' : '▶ 展示模式'}
      </button>

      {!demo.enabled ? (
        <span className="hint demo-idle">
          {`目前照真實時間。開啟後`
            + (monthOnly ? '' : '一天壓縮播放（15 分鐘 = 1 秒），')
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
            <strong>{slotToTime(demo.slot)}</strong>
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
    </div>
  )
}
