import { useEffect, useState } from 'react'
import Panel from './Panel'
import { DEVICES, slotToTime } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { loadPrefs, savePrefs, canSave, DEFAULT_PREFS } from '../api/prefs.js'

/* 可轉移設備的使用者設定：要不要跑、最晚幾點完成。

   設定存進雲端資料庫（POST /prefs），排程程式下次重排時把它當約束；
   同時存在這台裝置，並立刻用規則法重排一次讓畫面有反應（預覽），
   真正的最佳解要等排程跑完才會更新。

   ★ 只開放「要不要跑」與「最晚完成時間」，不開放指定幾點開——
     指定死了就沒有最佳化的空間，省錢效果會變差。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')

/** 該設備允許的完成時刻（每 15 分鐘一個選項，只列運轉結束落在允許時段內的） */
function deadlineOptions(devId) {
  const rule = SHIFTABLE_RULES[devId] ?? { dur: 4, windows: [[0, 24]] }
  const out = []
  for (const [a, b] of rule.windows) {
    for (let h = a + Math.ceil(rule.dur / 4); h <= b; h++) {
      const hh = h % 24
      out.push(`${String(hh).padStart(2, '0')}:00`)
    }
  }
  return [...new Set(out)]
}

export default function DevicePrefs({ onChange }) {
  const [devices, setDevices] = useState(DEFAULT_PREFS)
  const [meta, setMeta] = useState({ source: 'default', updatedAt: null })
  const [state, setState] = useState({ busy: false, msg: '' })

  useEffect(() => {
    let on = true
    loadPrefs().then((d) => {
      if (!on) return
      setDevices(d.devices)
      setMeta({ source: d.source, updatedAt: d.updatedAt })
      onChange?.(d.devices)
    })
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (id, patch) => {
    const next = { ...devices, [id]: { ...(devices[id] ?? { enabled: true }), ...patch } }
    if (patch.deadline === '') delete next[id].deadline
    setDevices(next)
    onChange?.(next)                      // 立刻預覽，不等儲存
  }

  const save = async () => {
    setState({ busy: true, msg: '' })
    const r = await savePrefs(devices)
    setState({
      busy: false,
      msg: r.saved === 'cloud'
        ? '已存到雲端，排程下次重排時會照這個設定'
        : `只存在這台裝置${r.error ? `（雲端寫入失敗：${r.error}）` : '（未設定雲端金鑰）'}`,
    })
    if (r.saved === 'cloud') setMeta({ source: 'cloud', updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') })
  }

  const where = { cloud: '雲端資料庫', local: '這台裝置', default: '預設值' }[meta.source]

  return (
    <Panel
      title="可轉移設備設定"
      sub={`目前來自${where}${meta.updatedAt ? `・更新於 ${meta.updatedAt}` : ''}`}
      className="mt-16"
      right={
        <button className="btn" onClick={save} disabled={state.busy}>
          {state.busy ? '儲存中…' : '儲存設定'}
        </button>
      }
    >
      <div className="prefs">
        {SHIFTABLE.map((dev) => {
          const p = devices[dev.id] ?? { enabled: true }
          const rule = SHIFTABLE_RULES[dev.id]
          return (
            <div className="prefs-row" key={dev.id}>
              <label className="prefs-name">
                <input
                  type="checkbox"
                  checked={p.enabled !== false}
                  onChange={(e) => update(dev.id, { enabled: e.target.checked })}
                />
                <span>{dev.icon} {dev.name}</span>
              </label>
              <div className="prefs-rule">
                {rule ? `可運轉 ${rule.text}・需 ${rule.dur * 15} 分鐘` : ''}
              </div>
              <label className="prefs-deadline">
                最晚完成
                <select
                  value={p.deadline ?? ''}
                  disabled={p.enabled === false}
                  onChange={(e) => update(dev.id, { deadline: e.target.value })}
                >
                  <option value="">不限</option>
                  {deadlineOptions(dev.id).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
            </div>
          )
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        改完會立刻在下方圖表預覽（規則法估算）。{canSave
          ? '按「儲存設定」寫回雲端資料庫，排程程式下次重排時會把它當約束，算出真正的最佳解。'
          : '目前未設定雲端金鑰，設定只會留在這台裝置。'}
        {state.msg && <><br /><b>{state.msg}</b></>}
      </p>
    </Panel>
  )
}
