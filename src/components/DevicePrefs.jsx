import { useEffect, useState } from 'react'
import Panel from './Panel'
import { DEVICES, slotToTime } from '../lib/constants.js'
import { SHIFTABLE_RULES } from '../lib/simulate.js'
import { loadPrefs, savePrefs, canSave, DEFAULT_PREFS } from '../api/prefs.js'

/* 可轉移設備的使用者設定：要不要跑、最晚幾點完成。

   設定存進雲端資料庫（POST /prefs），排程程式下次重排時把它當約束；
   同時存在這台裝置，並立刻用規則法重排一次讓畫面有反應（預覽），
   真正的最佳解要等排程跑完才會更新。

   ★ 只開放「要不要跑」與一個時間區間（最早幾點開始、最晚幾點完成），
     不開放指定確切幾點開——指定死了就沒有最佳化的空間，省錢效果會變差。
     區間是疊在設備本身的允許時段上的，不會蓋過它。
     最早晚於最晚代表跨午夜（洗碗機 19:00~隔天 07:00），下拉會標示「隔天」。 */

const SHIFTABLE = DEVICES.filter((d) => d.category === 'shiftable')

/** 該設備可選的時刻（整點）。kind='start' 列可以開始的、kind='end' 列可以完成的。
    from：已選的最早開始時刻。有的話，選項從它之後繞一圈排，跨午夜的才排在後面。 */
function hourOptions(devId, kind, from) {
  const rule = SHIFTABLE_RULES[devId] ?? { dur: 4, windows: [[0, 24]] }
  const hours = Math.ceil(rule.dur / 4)          // 運轉需要幾個整點
  const out = []
  for (const [a, b] of rule.windows) {
    const lo = kind === 'start' ? a : a + hours
    const hi = kind === 'start' ? b - hours : b
    for (let h = lo; h <= hi; h++) out.push(`${String(h % 24).padStart(2, '0')}:00`)
  }
  const base = from ? slot(from) : 0
  const order = (t) => (slot(t) - base + 96) % 96
  return [...new Set(out)].sort((x, y) => order(x) - order(y))
}

/** "HH:MM" → 第幾格；asEnd 時 00:00 代表一天結束 */
const slot = (t, asEnd = false) => {
  const [h, m] = t.split(':').map(Number)
  return (asEnd && h === 0 ? 24 : h) * 4 + Math.floor(m / 15)
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
    for (const k of ['earliest', 'deadline']) if (patch[k] === '') delete next[id][k]
    // 兩端相同是空的區間（後端會擋），清掉另一端。
    // 最早晚於最晚不是錯的，那代表跨午夜，例如洗碗機 19:00~隔天 07:00。
    const { earliest: e, deadline: d } = next[id]
    if (e && d && e === d) delete next[id][patch.earliest !== undefined ? 'deadline' : 'earliest']
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
              <div className="prefs-window">
                <label className="prefs-deadline">
                  最早開始
                  <select
                    value={p.earliest ?? ''}
                    disabled={p.enabled === false}
                    onChange={(e) => update(dev.id, { earliest: e.target.value })}
                  >
                    <option value="">不限</option>
                    {hourOptions(dev.id, 'start')
                      .filter((t) => t !== p.deadline)
                      .map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="prefs-deadline">
                  最晚完成
                  <select
                    value={p.deadline ?? ''}
                    disabled={p.enabled === false}
                    onChange={(e) => update(dev.id, { deadline: e.target.value })}
                  >
                    <option value="">不限</option>
                    {hourOptions(dev.id, 'end', p.earliest)
                      .filter((t) => t !== p.earliest)
                      .map((t) => (
                        <option key={t} value={t}>
                          {p.earliest && slot(t, true) <= slot(p.earliest) ? `${t}（隔天）` : t}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
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
