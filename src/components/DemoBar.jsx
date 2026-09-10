/* ============================================================
   展示模式控制列

   期末口試沒辦法站在台上等一整天，這條列子把一天壓縮成 96 秒播完
   （15 分鐘 = 1 秒）。它只負責操作 lib/demoClock.js 的虛擬時鐘，
   畫面本身不特別處理——整個 UI 的即時區塊都是由時鐘推導的，
   時鐘一加速，能源流向、KPI、設備開關、尖離峰標示就一起動起來。
   ============================================================ */
import {
  useDemoClock,
  toggleDemo,
  togglePlay,
  restartDemo,
  seekDemo,
  setSpeed,
  SPEEDS,
} from '../lib/demoClock.js'
import { SLOTS_PER_DAY, slotToTime } from '../lib/constants.js'

export default function DemoBar() {
  const demo = useDemoClock()
  const speed = SPEEDS.find((s) => s.key === demo.speed) ?? SPEEDS[0]

  return (
    <div className={`demo-bar ${demo.enabled ? 'on' : ''}`}>
      <button
        className={`demo-power ${demo.enabled ? 'on' : ''}`}
        onClick={toggleDemo}
        title={demo.enabled ? '關閉展示模式，回到真實時間' : '開啟展示模式：一天壓縮成 96 秒'}
      >
        {demo.enabled ? '⏹ 結束展示' : '▶ 展示模式'}
      </button>

      {!demo.enabled ? (
        <span className="hint demo-idle">
          把一天壓縮播放（15 分鐘 = 1 秒），用來展示排程一整天的運作
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

          <span className="hint demo-note">{speed.hint}</span>
        </>
      )}
    </div>
  )
}
