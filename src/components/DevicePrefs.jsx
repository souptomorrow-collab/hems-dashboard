import Panel from './Panel'
import { DEVICES } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { canSave } from '../api/prefs.js'
import { DEFAULT_RANGE, HARD_END, durOf, hm, slotOf, latestStart } from '../lib/deviceJobs.js'

/* 隔日可轉移設備的條件（2026-09-23 定案：滾動決定、開機才定案）

   每台三種：系統決定（可以設最早開始、最晚完成）／指定時間／不跑。
   在下方甘特圖上拖動也是指定時間。幾點開由排程決定：日前排程先排出預估時間，
   當天實時層每 15 分鐘用最新預測重排，排到「現在開」才開機，開了就跑完。
   條件、預估時間都在上層（Planning），這裡只負責顯示與操作。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')
const md = (date) => (date ? `${+date.slice(5, 7)}/${+date.slice(8, 10)}` : '')
const MODES = [['auto', '系統決定'], ['fixed', '指定時間'], ['off', '不跑']]
const TIMES = Array.from({ length: 97 }, (_, i) => hm(i)) // 00:00 … 24:00

/** 某台設備目前的狀態文字（甘特圖名稱欄也用） */
export function deviceStatus(c, start) {
  if (!c || c.mode === 'off') return { tone: 'off', text: '不跑' }
  if (c.mode === 'fixed') return { tone: 'fixed', text: `指定 ${hm(c.start)} 開` }
  return { tone: 'auto', text: start == null ? '系統決定' : `系統決定・預估 ${hm(start)} 開` }
}

function TimeSelect({ id, value, onChange, from = 0, to = 96, label }) {
  return (
    <select id={id} className="time-select" value={value} aria-label={label}
      onChange={(e) => onChange(e.target.value)}>
      {TIMES.slice(from, to + 1).map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  )
}

export default function DevicePrefs({
  cond, est, estSource, date, cloud, dirty, sending, msg, problems = [],
  onChange, onAllOff, onAllDefault, onSubmit,
}) {
  if (!cond) return null
  const errors = problems.filter((p) => p.level === 'error')
  const on = SHIFTABLE.filter((d) => cond[d.id]?.mode !== 'off').length
  const sourceText = estSource === 'schedule'
    ? '預估時間來自日前排程（排程組 MILP，設備和電池一起排）'
    : cloud
    ? '改了條件還沒送出：預估時間先依電價估，送出後由排程重算'
    : '預估時間依電價估（不看太陽能與電池）'

  return (
    <Panel
      title={`隔日可轉移設備${date ? `（${md(date)}）` : ''}`}
      sub="設條件就好，幾點開由排程決定・開機後連續跑完・烘衣機要在洗衣機之後、22:00 前跑完"
      className="mt-16"
      right={(
        <div className="prefs-actions">
          <button className="btn" onClick={onAllOff} disabled={sending || on === 0}>明天都不用</button>
          <button className="btn" onClick={onAllDefault} disabled={sending}>全部回到預設</button>
          {cloud && (
            <button className="btn primary" onClick={onSubmit} disabled={sending || !dirty || !canSave || errors.length > 0}
              title={!canSave ? '未設定雲端金鑰' : errors.length ? '先修正標 ⛔ 的問題' : dirty ? '送出條件，本機從隔日起重排' : '和已送出的條件相同'}>
              {sending ? '送出中…' : '送出給排程'}
            </button>
          )}
        </div>
      )}
    >
      <p className="prefs-phase" role="note">
        {cloud
          ? '日前排程（前一晚 23:45）先排出預估時間；當天實時層每 15 分鐘用最新預測重排，排到「現在開」才開機。'
            + '改好按「送出給排程」，本機從隔日起重排、今天以前不動；改的條件會沿用到月底。'
          : '平常模式是模擬的：改了條件電費即時重算，不會送出。開啟展示模式才照排程組的排程跑。'}
        <span className="dim">　{sourceText}</span>
      </p>
      <div className="prefs">
        {SHIFTABLE.map((dev) => {
          const c = cond[dev.id]
          const id = dev.id
          const n = durOf(id)
          const st = deviceStatus(c, est?.[id])
          const [e0, d0] = DEFAULT_RANGE[id]
          const changed = c.earliest !== e0 || c.deadline !== d0
          const mine = problems.filter((p) => p.devId === id)
          return (
            <div className="prefs-row" key={id}>
              <div className="prefs-name">
                <span>{dev.icon} {dev.name}</span>
                <span className={`confirm-chip ${st.tone}`}>{st.text}</span>
              </div>
              <div className="prefs-rule">
                {c.mode === 'auto' && (
                  <>
                    <label className="range-line">
                      最早
                      <TimeSelect id={`${id}-earliest`} label={`${dev.name}最早開始`} value={c.earliest} to={95}
                        onChange={(v) => onChange(id, { earliest: v })} />
                      開始，最晚
                      <TimeSelect id={`${id}-deadline`} label={`${dev.name}最晚完成`} value={c.deadline} from={1}
                        to={HARD_END[id] ?? 96} onChange={(v) => onChange(id, { deadline: v })} />
                      完成
                    </label>
                    <div>
                      預設 {SHIFTABLE_RULES[id].text}・需 {n * 15} 分鐘
                      {changed && (
                        <button className="btn-link" onClick={() => onChange(id, { earliest: e0, deadline: d0 })}>回到預設範圍</button>
                      )}
                    </div>
                  </>
                )}
                {c.mode === 'fixed' && (
                  <label className="range-line">
                    從
                    <TimeSelect id={`${id}-start`} label={`${dev.name}指定開始時間`} value={hm(c.start)} to={latestStart(id)}
                      onChange={(v) => onChange(id, { start: slotOf(v) })} />
                    開始，跑到 {hm(c.start + n)}（{n * 15} 分鐘，當一般負載）
                  </label>
                )}
                {c.mode === 'off' && <span className="dim">明天不運轉</span>}
              </div>
              <div className="prefs-when">
                <div className="mode-seg" role="radiogroup" aria-label={`${dev.name}怎麼決定`}>
                  {MODES.map(([m, label]) => (
                    <button key={m} role="radio" aria-checked={c.mode === m}
                      className={`seg${c.mode === m ? ' on' : ''}`}
                      onClick={() => onChange(id, m === 'fixed' && c.start == null
                        ? { mode: m, start: est?.[id] ?? slotOf(e0) }
                        : { mode: m })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {mine.length > 0 && (
                <div className="prefs-issues">
                  {mine.map((x) => (
                    <span key={x.text} className={`issue ${x.level}`}>
                      {x.level === 'error' ? '⛔' : '⚠️'} {x.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {msg && <p className="hint" style={{ marginTop: 10 }} role="status"><b>{msg}</b></p>}
    </Panel>
  )
}
