import Panel from './Panel'
import { DEVICES } from '../lib/constants.js'
import { canSave } from '../api/prefs.js'
import { DEFAULT_RANGE, HARD_END, SHIFT_IDS, PLAN_CUTOFF_SLOT, durOf, hm, slotOf, latestStart, followsRec } from '../lib/deviceJobs.js'

/* 用戶規劃：可轉移設備（2026-09-23 定案：滾動決定、開機才定案；沒排就不開）

   兩種排法：常駐排程＝從隔日起每天都照這個排；明日排程＝只排隔日，後天照常駐排程。
   最上面是建議時間：三台都照建議時最省的開機時間（日前排程另外算的 MILP 解），
   可以一鍵「全部照建議排」，或逐台按「照建議」。沒排的設備不開。
   每台三種：系統決定（範圍沒改＝照建議，也可以自己設最早開始、最晚完成）／指定時間／不開。
   在下方甘特圖上拖動也是指定時間。改好按「重排」儲存（覆寫之前送出的），23:45 以前可以一直改；
   23:45 截止時本機照最後一份設定排定隔日。「復原更改」回到上次送出的條件。
   隔日的規劃在今天 23:45 截止（日前排程在那時排定隔日）；截止到午夜之間整區鎖住，午夜後換成規劃下一天。
   條件、預估時間、建議時間都在上層（Planning），這裡只負責顯示與操作。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')
const md = (date) => (date ? `${+date.slice(5, 7)}/${+date.slice(8, 10)}` : '')
const MODES = [['auto', '系統決定'], ['fixed', '指定時間'], ['off', '不開']]
const PLAN_MODES = [['standing', '常駐排程'], ['day', '明日排程']]
const TIMES = Array.from({ length: 97 }, (_, i) => hm(i)) // 00:00 … 24:00
const span = (id, s) => (s == null ? '—' : `${hm(s)}–${hm(s + durOf(id))}`)

/** 某台設備目前的狀態文字（設備名稱旁的標籤） */
export function deviceStatus(cond, id, start) {
  const c = cond?.[id]
  if (!c || c.mode === 'off') return { tone: 'off', text: '不開' }
  if (c.mode === 'fixed') return { tone: 'fixed', text: `指定 ${hm(c.start)} 開` }
  const head = followsRec(cond, id) ? '照建議' : '系統決定'
  return { tone: 'auto', text: start == null ? head : `${head}・預估 ${hm(start)} 開` }
}

function TimeSelect({ id, value, onChange, from = 0, to = 96, label }) {
  return (
    <select id={id} className="time-select" value={value} aria-label={label}
      onChange={(e) => onChange(e.target.value)}>
      {TIMES.slice(from, to + 1).map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  )
}

/* recCost：三台都照建議的電費；curCost：目前排法的電費。mode：standing／day；busy＝載入或送出中；
   waiting＝已送出、本機還在照新設定重排；closed＝已過 23:45，隔日的規劃截止 */
export default function DevicePrefs({
  cond, est, rec, recCost, curCost, diffs = {}, date, closed = false, mode, onMode, dirty, busy, sending, waiting, msg,
  problems = [], onChange, onFollow, onAllOff, onAllRec, onUndo, onSubmit,
}) {
  if (!cond) return null
  const errors = problems.filter((p) => p.level === 'error')
  const on = SHIFTABLE.filter((d) => cond[d.id]?.mode !== 'off').length
  const allRec = SHIFT_IDS.every((id) => followsRec(cond, id))
  const lock = sending || closed
  const due = closed ? '已截止' : `今日 ${hm(PLAN_CUTOFF_SLOT)} 截止`

  return (
    <Panel
      title={mode === 'standing' ? `用戶規劃・常駐排程（${md(date)} 起每天，${due}）` : `用戶規劃・明日排程（${md(date)}，${due}）`}
      className="mt-16"
      right={(
        <div className="prefs-actions">
          <div className="seg" role="radiogroup" aria-label="排法">
            {PLAN_MODES.map(([m, label]) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'active' : ''}
                onClick={() => onMode(m)} disabled={lock}>
                {label}
              </button>
            ))}
          </div>
          <button className="btn" onClick={onAllOff} disabled={lock || on === 0}>全部不開</button>
          <button className="btn" onClick={onAllRec} disabled={lock || allRec}>全部照建議排</button>
          <button className="btn" onClick={onUndo} disabled={busy || closed || !dirty}>↺ 復原更改</button>
          <button className="btn primary" onClick={onSubmit} disabled={busy || closed || !dirty || !canSave || errors.length > 0}
            title={closed ? `隔日的規劃已於 ${hm(PLAN_CUTOFF_SLOT)} 截止` : !canSave ? '未設定雲端金鑰' : errors.length ? '先修正標 ⛔ 的問題' : dirty ? '儲存這份規劃，今日 23:45 截止時排定' : '和已送出的相同'}>
            {sending ? '送出中…' : '重排'}
          </button>
        </div>
      )}
    >
      {rec && (
        <div className="rec-box" role="note" aria-label="建議時間">
          <div className="rec-head">
            <b>💡 建議時間</b>
          </div>
          <div className="rec-list">
            {SHIFTABLE.map((d) => (
              <span key={d.id}>{d.icon} {d.name} <b>{span(d.id, rec[d.id])}</b></span>
            ))}
          </div>
          {recCost != null && (
            <div className="rec-cost">
              三台都照建議排：預估電費 <b>{recCost}</b> 元
              {!allRec && curCost != null && `（目前的排法 ${curCost} 元）`}
            </div>
          )}
        </div>
      )}

      {/* 截止後整區鎖住（fieldset disabled 會一併停用裡面所有按鈕與選單） */}
      <fieldset className="prefs-lock" disabled={closed}>
      <div className="prefs">
        {SHIFTABLE.map((dev) => {
          const c = cond[dev.id]
          const id = dev.id
          const n = durOf(id)
          const st = deviceStatus(cond, id, est?.[id])
          const [e0, d0] = DEFAULT_RANGE[id]
          const changed = c.earliest !== e0 || c.deadline !== d0
          const mine = problems.filter((p) => p.devId === id)
          const diff = diffs[id]
          const r = rec?.[id]
          return (
            <div className="prefs-row" key={id}>
              {/* 設備名稱不換行：1024 寬時會斷成「洗／衣機」；狀態標籤放不下就換到下一行 */}
              <div className="prefs-name" style={{ flexWrap: 'wrap' }}>
                <span style={{ whiteSpace: 'nowrap' }}>{dev.icon} {dev.name}</span>
                <span className={`confirm-chip ${st.tone}`}>{st.text}</span>
              </div>
              <div className="prefs-rule">
                {c.mode === 'auto' && (
                  <label className="range-line">
                    最早
                    {/* 有硬性限制的（烘衣機 22:00 前跑完）只列來得及跑完的最早開始（20:30 以前）；
                        資料庫讀到的值更晚時也列出來，畫面才對得上（下面會標 ⛔） */}
                    <TimeSelect id={`${id}-earliest`} label={`${dev.name}最早開始`} value={c.earliest}
                      to={HARD_END[id] ? Math.max(HARD_END[id] - n, slotOf(c.earliest)) : 95}
                      onChange={(v) => onChange(id, { earliest: v })} />
                    開始，最晚
                    <TimeSelect id={`${id}-deadline`} label={`${dev.name}最晚完成`} value={c.deadline} from={1}
                      to={HARD_END[id] ?? 96} onChange={(v) => onChange(id, { deadline: v })} />
                    完成
                    {changed && <button className="btn-link" onClick={() => onFollow(id)}>改回照建議</button>}
                  </label>
                )}
                {c.mode === 'fixed' && (
                  <label className="range-line">
                    從
                    <TimeSelect id={`${id}-start`} label={`${dev.name}指定開始時間`} value={hm(c.start)}
                      to={Math.max(latestStart(id), c.start)} onChange={(v) => onChange(id, { start: slotOf(v) })} />
                    開始，跑到 {c.start + n > 96 ? `隔天 ${hm(c.start + n - 96)}` : hm(c.start + n)}
                    {r != null && <button className="btn-link" onClick={() => onFollow(id)}>改回照建議</button>}
                  </label>
                )}
                {c.mode === 'off' && (
                  <div className="range-line">
                    <button className="btn follow-btn" onClick={() => onFollow(id)} disabled={lock}>照建議</button>
                  </div>
                )}
              </div>
              <div className="prefs-when">
                <div className="mode-seg" role="radiogroup" aria-label={`${dev.name}怎麼排`}>
                  {MODES.map(([m, label]) => (
                    <button key={m} role="radio" aria-checked={c.mode === m}
                      className={`seg${c.mode === m ? ' on' : ''}`}
                      onClick={() => onChange(id, m === 'fixed' && c.mode !== 'fixed'
                        ? { mode: m, start: est?.[id] ?? r ?? slotOf(e0) }
                        : { mode: m })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {(mine.length > 0 || (diff != null && diff > 0)) && (
                <div className="prefs-issues">
                  {mine.map((x) => (
                    <span key={x.text} className={`issue ${x.level}`}>
                      {x.level === 'error' ? '⛔' : '⚠️'} {x.text}
                    </span>
                  ))}
                  {diff != null && diff > 0 && (
                    <span className="issue warn">💸 比建議時間（{hm(r)}）多花約 {diff} 元</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      </fieldset>
      {closed && (
        <p style={{ marginTop: 10 }} role="status">
          <b>⏰ {md(date)} 的規劃已於今日 {hm(PLAN_CUTOFF_SLOT)} 截止，00:00 起可規劃下一天。</b>
        </p>
      )}
      {(msg || waiting) && (
        <p style={{ marginTop: 10 }} role="status"><b>{msg || '⏳ 已截止，本機正在照最後一份設定排定隔日…'}</b></p>
      )}
    </Panel>
  )
}
