import Panel from './Panel'
import { DEVICES } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { canSave } from '../api/prefs.js'
import { DEFAULT_RANGE, HARD_END, SHIFT_IDS, durOf, hm, slotOf, latestStart, followsRec } from '../lib/deviceJobs.js'

/* 隔日可轉移設備（2026-09-23 定案：滾動決定、開機才定案；沒排就不開、只排明天）

   最上面是建議時間：三台都照建議時最省的開機時間（展示模式是日前排程另外算的 MILP 解），
   可以一鍵「全部照建議排」，或逐台按「照建議」。沒排的設備明天不開。
   每台三種：系統決定（範圍沒改＝照建議，也可以自己設最早開始、最晚完成）／指定時間／不開。
   在下方甘特圖上拖動也是指定時間。幾點開由排程決定：日前排程先排出預估時間，
   當天實時層每 15 分鐘用最新預測重排，排到「現在開」才開機，開了就跑完。
   條件、預估時間、建議時間都在上層（Planning），這裡只負責顯示與操作。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')
const md = (date) => (date ? `${+date.slice(5, 7)}/${+date.slice(8, 10)}` : '')
const MODES = [['auto', '系統決定'], ['fixed', '指定時間'], ['off', '不開']]
const TIMES = Array.from({ length: 97 }, (_, i) => hm(i)) // 00:00 … 24:00
const span = (id, s) => (s == null ? '—' : `${hm(s)}–${hm(s + durOf(id))}`)

/** 某台設備目前的狀態文字（甘特圖名稱欄也用） */
export function deviceStatus(cond, id, start) {
  const c = cond?.[id]
  if (!c || c.mode === 'off') return { tone: 'off', text: '沒排・不開' }
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

export default function DevicePrefs({
  cond, est, estSource, rec, recSource, recCost, curCost, diffs = {}, date, cloud, dirty, sending, msg,
  problems = [], onChange, onFollow, onAllOff, onAllRec, onSubmit,
}) {
  if (!cond) return null
  const errors = problems.filter((p) => p.level === 'error')
  const on = SHIFTABLE.filter((d) => cond[d.id]?.mode !== 'off').length
  const allRec = SHIFT_IDS.every((id) => followsRec(cond, id))
  const sourceText = estSource === 'schedule'
    ? '預估時間來自日前排程（排程組 MILP，設備和電池一起排）'
    : cloud
    ? '改了條件還沒送出：照建議的設備用建議時間，其他先依電價估；送出後由排程重算'
    : '預估時間依電價估（不看太陽能與電池）'
  const recText = recSource === 'schedule'
    ? '排程組 MILP 算的最省時間（三台都照建議，設備和電池一起排）'
    : '依電價估的最便宜時間（不看太陽能與電池）'

  return (
    <Panel
      title={`隔日可轉移設備${date ? `（${md(date)}）` : ''}`}
      sub="只排明天・沒排的不開・幾點開由排程決定・開機後連續跑完・烘衣機要在洗衣機之後、22:00 前跑完"
      className="mt-16"
      right={(
        <div className="prefs-actions">
          <button className="btn" onClick={onAllOff} disabled={sending || on === 0}>明天都不用</button>
          <button className="btn" onClick={onAllRec} disabled={sending || allRec}
            title={allRec ? '三台已經都照建議' : '三台都排進去，在建議範圍內由系統決定幾點開'}>
            全部照建議排
          </button>
          {cloud && (
            <button className="btn primary" onClick={onSubmit} disabled={sending || !dirty || !canSave || errors.length > 0}
              title={!canSave ? '未設定雲端金鑰' : errors.length ? '先修正標 ⛔ 的問題' : dirty ? '送出明天的排法，本機重排隔日以後的日子' : '和已送出的條件相同'}>
              {sending ? '送出中…' : '送出給排程'}
            </button>
          )}
        </div>
      )}
    >
      <p className="prefs-phase" role="note">
        {cloud
          ? '只排明天：沒排的設備明天不開，後天要用到時候再排。日前排程（前一晚 23:45）先排出預估時間；'
            + '當天實時層每 15 分鐘用最新預測重排，排到「現在開」才開機。'
            + '改好按「送出給排程」，本機重排隔日以後的日子（電量一天接一天）、今天以前不動。'
          : '平常模式是模擬的：沒排的設備明天不開；改了條件電費即時重算，不會送出。開啟展示模式才照排程組的排程跑。'}
        <span className="dim">　{sourceText}</span>
      </p>

      {rec && (
        <div className="rec-box" role="note" aria-label="建議時間">
          <div className="rec-head">
            <b>💡 建議時間</b>
            <span className="dim">{recText}</span>
          </div>
          <div className="rec-list">
            {SHIFTABLE.map((d) => (
              <span key={d.id}>{d.icon} {d.name} <b>{span(d.id, rec[d.id])}</b></span>
            ))}
          </div>
          {recCost != null && (
            <div className="rec-cost">
              三台都照建議排：明天預估電費 <b>{recCost}</b> 元
              {!allRec && curCost != null && `（目前的排法 ${curCost} 元）`}
            </div>
          )}
        </div>
      )}

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
                      建議範圍 {SHIFTABLE_RULES[id].text}・需 {n * 15} 分鐘
                      {changed && (
                        <button className="btn-link" onClick={() => onFollow(id)}>改回照建議</button>
                      )}
                    </div>
                  </>
                )}
                {c.mode === 'fixed' && (
                  <>
                    <label className="range-line">
                      從
                      <TimeSelect id={`${id}-start`} label={`${dev.name}指定開始時間`} value={hm(c.start)} to={latestStart(id)}
                        onChange={(v) => onChange(id, { start: slotOf(v) })} />
                      開始，跑到 {hm(c.start + n)}（{n * 15} 分鐘，當一般負載）
                    </label>
                    {r != null && (
                      <div>
                        建議 {span(id, r)}
                        <button className="btn-link" onClick={() => onFollow(id)}>改回照建議</button>
                      </div>
                    )}
                  </>
                )}
                {c.mode === 'off' && (
                  <div className="range-line">
                    <span className="dim">明天不開{r != null ? `・建議 ${span(id, r)} 開最省` : ''}</span>
                    <button className="btn follow-btn" onClick={() => onFollow(id)} disabled={sending}>照建議</button>
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
              {(mine.length > 0 || diff != null) && (
                <div className="prefs-issues">
                  {mine.map((x) => (
                    <span key={x.text} className={`issue ${x.level}`}>
                      {x.level === 'error' ? '⛔' : '⚠️'} {x.text}
                    </span>
                  ))}
                  {diff != null && (
                    <span className="issue warn">
                      {diff > 0 ? `💸 比建議時間（${hm(r)}）多花約 ${diff} 元`
                        : diff < 0 ? `比建議時間（${hm(r)}）少花約 ${-diff} 元（電池照原排程時）`
                        : `和建議時間（${hm(r)}）的電費差不多`}
                    </span>
                  )}
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
