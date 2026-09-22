import { useEffect, useState } from 'react'
import Panel from './Panel'
import { DEVICES } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { loadPrefs, savePrefs, canSave, toSegments } from '../api/prefs.js'
import { checkDevice, checkAll } from '../lib/deviceCheck.js'

/* 隔日的可轉移設備要在什麼時候跑。

   使用者只能調整隔日（date，資料集日期）。存下後本機從隔日起重新排程，今天以前已經排好、跑過的不動。
   時段由使用者在下方的甘特圖上拖出來，這裡只顯示摘要並存回雲端資料庫，
   本機的排程程式看到就照這個時段算用電。沒排的設備不會運轉——
   這套系統不替使用者決定時間，只算出「排在這個時段要花多少電費」。

   時段的真相在上層的 schedule（甘特圖那一份），這裡不另存一份，
   免得兩邊各存各的、改了一邊忘了另一邊。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')

/** "18:00" → 分鐘數（24:00 算一天結束） */
const mins = (t) => (t === '24:00' ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3)))

const md = (date) => (date ? `${+date.slice(5, 7)}/${+date.slice(8, 10)}` : '')

/* cloud：展示模式才讀寫雲端設定、送去本機排程；平常是模擬的，甘特圖調整後電費即時重算就好 */
export default function DevicePrefs({ schedule, date, monthView = false, cloud = true, onClear, onLoaded, onSaved }) {
  const [meta, setMeta] = useState({ source: 'default', updatedAt: null })
  const [state, setState] = useState({ busy: false, msg: '' })
  const [armed, setArmed] = useState(false)      // 有問題時要按第二次才真的存

  const issues = checkAll(schedule)
  const errors = issues.filter((i) => i.level === 'error')
  const empty = SHIFTABLE.every((d) => !toSegments(schedule?.[d.id]).length)

  useEffect(() => { setArmed(false) }, [schedule])   // 改過就重新要求確認

  // 切換夏月／非夏月時隔日也跟著換（7/20 ↔ 1/12），重讀那天適用的設定
  useEffect(() => {
    let on = true
    setState({ busy: false, msg: '' })
    if (!cloud) {
      setMeta({ source: 'sim', updatedAt: null })
      return undefined
    }
    loadPrefs(date).then((d) => {
      if (!on) return
      setMeta({ source: d.source, updatedAt: d.updatedAt })
      // 存過才套用；從沒存過就讓畫面留著排程給的建議時段，使用者有個起點可以拖
      if (d.source !== 'default') onLoaded?.(d.devices)
    })
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, cloud])

  const save = async () => {
    if (!armed && (errors.length || empty)) {
      setArmed(true)
      setState({
        busy: false,
        msg: empty
          ? '三台都沒排，存下去之後都不會運轉。確定的話再按一次「儲存給排程」。'
          : `還有 ${errors.length} 項問題（見上方紅字）。要照這樣存，再按一次「儲存給排程」。`,
      })
      return
    }
    setState({ busy: true, msg: '' })
    const devices = Object.fromEntries(SHIFTABLE.map((d) => {
      const slots = toSegments(schedule?.[d.id])
      return [d.id, slots.length ? { enabled: true, slots } : { enabled: false }]
    }))
    const r = await savePrefs(devices, date)
    onSaved?.(devices)
    setState({
      busy: false,
      msg: r.saved === 'cloud'
        ? `已存到雲端。本機排程程式會從隔日（${md(date)}）起重排，今天以前不動；`
          + (monthView ? '頁面最下方「整月排程與實時運轉」看得到一天一天換成新設定' : '隔日重排好後這頁會自動更新')
        : `只存在這台裝置${r.error ? `（雲端寫入失敗：${r.error}）` : '（未設定雲端金鑰）'}`,
    })
    setArmed(false)
    if (r.saved === 'cloud') {
      setMeta({ source: 'cloud', updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') })
    }
  }

  const where = { cloud: '雲端資料庫', local: '這台裝置', default: '預設值', sim: '模擬' }[meta.source]

  return (
    <Panel
      title={`隔日可轉移設備設定${date ? `（${md(date)}）` : ''}`}
      sub={`只能調整隔日・在下方甘特圖上拖出運轉時段・來自${where}${meta.updatedAt ? `・更新於 ${meta.updatedAt}` : ''}`}
      className="mt-16"
      right={cloud ? (
        <button className={`btn${armed ? ' btn-armed' : ''}`} onClick={save} disabled={state.busy}>
          {state.busy ? '儲存中…' : armed ? '仍要儲存' : '儲存給排程'}
        </button>
      ) : null}
    >
      <div className="prefs">
        {SHIFTABLE.map((dev) => {
          const segs = toSegments(schedule?.[dev.id])
          const rule = SHIFTABLE_RULES[dev.id]
          const problems = checkDevice(dev.id, schedule)
          return (
            <div className="prefs-row" key={dev.id}>
              <div className="prefs-name">
                <span>{dev.icon} {dev.name}</span>
              </div>
              <div className="prefs-rule">
                {rule ? `可運轉 ${rule.text}・需 ${rule.dur * 15} 分鐘` : ''}
              </div>
              <div className="prefs-when">
                {segs.length ? (
                  <>
                    <b>{segs.map(([a, b]) => `${a}~${b}`).join('、')}</b>
                    <button className="btn-link" onClick={() => onClear?.(dev.id)}>清除</button>
                  </>
                ) : (
                  <span className="muted">沒排，不會運轉</span>
                )}
              </div>
              {problems.length > 0 && (
                <div className="prefs-issues">
                  {problems.map((x) => (
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
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        在下方甘特圖上按住拖曳就是設定隔日的運轉時段。沒排的設備不會運轉，排程不會替你決定時間。
        {cloud ? (
          <>
            存下後從隔日起重新排程（之後每天沿用，直到下次再改），今天以前已經排好、跑過的不動。
            {meta.source === 'default' && '目前顯示的是建議時段，還沒有存過——按下儲存才會生效。'}{canSave
              ? '排好後按「儲存給排程」寫回雲端資料庫，本機的排程程式看到就重算。'
              : '目前未設定雲端金鑰，設定只會留在這台裝置。'}
          </>
        ) : '平常模式是模擬的：拖完電費即時重算，不會送去排程。要照使用者設定跑真的排程，請開啟展示模式。'}
        {state.msg && <><br /><b>{state.msg}</b></>}
      </p>
    </Panel>
  )
}
