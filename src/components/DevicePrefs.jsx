import { useEffect, useState } from 'react'
import Panel from './Panel'
import { DEVICES } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { loadPrefs, savePrefs, canSave, toSegments } from '../api/prefs.js'

/* 可轉移設備要在什麼時候跑。

   時段由使用者在下方的甘特圖上拖出來，這裡只顯示摘要並存回雲端資料庫，
   本機的排程程式看到就照這個時段算用電。沒排的設備不會運轉——
   這套系統不替使用者決定時間，只算出「排在這個時段要花多少電費」。

   時段的真相在上層的 schedule（甘特圖那一份），這裡不另存一份，
   免得兩邊各存各的、改了一邊忘了另一邊。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')

/** "18:00" → 分鐘數（24:00 算一天結束） */
const mins = (t) => (t === '24:00' ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3)))

export default function DevicePrefs({ schedule, onClear, onLoaded }) {
  const [meta, setMeta] = useState({ source: 'default', updatedAt: null })
  const [state, setState] = useState({ busy: false, msg: '' })

  useEffect(() => {
    let on = true
    loadPrefs().then((d) => {
      if (!on) return
      setMeta({ source: d.source, updatedAt: d.updatedAt })
      // 存過才套用；從沒存過就讓畫面留著排程給的建議時段，使用者有個起點可以拖
      if (d.source !== 'default') onLoaded?.(d.devices)
    })
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    setState({ busy: true, msg: '' })
    const devices = Object.fromEntries(SHIFTABLE.map((d) => {
      const slots = toSegments(schedule?.[d.id])
      return [d.id, slots.length ? { enabled: true, slots } : { enabled: false }]
    }))
    const r = await savePrefs(devices)
    setState({
      busy: false,
      msg: r.saved === 'cloud'
        ? '已存到雲端，排程會照這些時段跑'
        : `只存在這台裝置${r.error ? `（雲端寫入失敗：${r.error}）` : '（未設定雲端金鑰）'}`,
    })
    if (r.saved === 'cloud') {
      setMeta({ source: 'cloud', updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') })
    }
  }

  const where = { cloud: '雲端資料庫', local: '這台裝置', default: '預設值' }[meta.source]

  return (
    <Panel
      title="可轉移設備設定"
      sub={`在下方甘特圖上拖出運轉時段・來自${where}${meta.updatedAt ? `・更新於 ${meta.updatedAt}` : ''}`}
      className="mt-16"
      right={
        <button className="btn" onClick={save} disabled={state.busy}>
          {state.busy ? '儲存中…' : '儲存給排程'}
        </button>
      }
    >
      <div className="prefs">
        {SHIFTABLE.map((dev) => {
          const segs = toSegments(schedule?.[dev.id])
          const rule = SHIFTABLE_RULES[dev.id]
          const total = segs.reduce((n, [a, b]) => n + mins(b) - mins(a), 0)
          const need = rule ? rule.dur * 15 : null
          return (
            <div className="prefs-row" key={dev.id}>
              <div className="prefs-name">
                <span>{dev.icon} {dev.name}</span>
              </div>
              <div className="prefs-rule">
                {rule ? `可運轉 ${rule.text}・需 ${need} 分鐘` : ''}
              </div>
              <div className="prefs-when">
                {segs.length ? (
                  <>
                    <b>{segs.map(([a, b]) => `${a}~${b}`).join('、')}</b>
                    {need !== null && total !== need && (
                      <span className="prefs-warn">　共 {total} 分鐘，需要 {need} 分鐘</span>
                    )}
                    <button className="btn-link" onClick={() => onClear?.(dev.id)}>清除</button>
                  </>
                ) : (
                  <span className="muted">沒排，不會運轉</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        在下方甘特圖上按住拖曳就是設定運轉時段。沒排的設備不會運轉，排程不會替你決定時間。
        {meta.source === 'default' && '目前顯示的是建議時段，還沒有存過——按下儲存才會生效。'}{canSave
          ? '排好後按「儲存給排程」寫回雲端資料庫，本機的排程程式看到就重算。'
          : '目前未設定雲端金鑰，設定只會留在這台裝置。'}
        {state.msg && <><br /><b>{state.msg}</b></>}
      </p>
    </Panel>
  )
}
