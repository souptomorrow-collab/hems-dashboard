/* ============================================================
   系統常數：時間解析度、電池規格、設備清單、配色
   ============================================================ */

// ---- 時間解析度（以 15 分鐘為單位）----
export const SLOT_MINUTES = 15
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES // 96
export const SLOT_HOURS = SLOT_MINUTES / 60 // 0.25 小時

/** slot 索引 (0~95) → "HH:MM" 字串 */
export function slotToTime(slot) {
  const mins = slot * SLOT_MINUTES
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** slot 索引 → 該時段所屬的小時 (0~23) */
export function slotToHour(slot) {
  return Math.floor((slot * SLOT_MINUTES) / 60)
}

// ---- 電池規格（參考 Tesla Powerwall 2）----
export const BATTERY = {
  capacityKwh: 13.5, // 可用電量
  maxPowerKw: 5, // 最大連續充放電功率
  socMin: 0.15, // 下限 15%（計畫書更新版：由 10% 上修以延長壽命）
  socMax: 0.9, // 上限 90%
  socInit: 0.15, // 初始電量 15%
  roundTrip: 0.9, // 往返效率
}

// ---- 家庭負載設備（對應計畫書表 1）----
// category: 'shiftable' 可轉移 / 'fixed' 不可轉移
// ratedW: 額定功率 (瓦)
export const DEVICES = [
  // 可轉移（額定功率採用 Dinh et al., IEEE Access 2020, Table 4；運轉時間依台灣家庭作息設定）
  { id: 'washer', name: '洗衣機', category: 'shiftable', ratedW: 800, icon: '🧺' },
  { id: 'dryer', name: '烘衣機', category: 'shiftable', ratedW: 700, icon: '🌀' },
  { id: 'dishwasher', name: '洗碗機', category: 'shiftable', ratedW: 200, icon: '🍽️' },
  // 不可轉移（同樣採用文獻之額定功率；冰箱為壓縮機額定，實際功率見 simulate.js 的工作週期）
  { id: 'computer', name: '電腦', category: 'fixed', ratedW: 200, icon: '💻' },
  { id: 'security', name: '監控設備', category: 'fixed', ratedW: 100, icon: '📹' },
  { id: 'microwave', name: '微波爐', category: 'fixed', ratedW: 500, icon: '🍱' },
  // capW：分配預測總量時的上限。冰箱 24 小時開著，用額定 900 W 當上限會被塞進一整天的電
  { id: 'fridge', name: '冰箱', category: 'fixed', ratedW: 900, capW: 90, icon: '🧊' },
  { id: 'tv', name: '電視', category: 'fixed', ratedW: 200, icon: '📺' },
  { id: 'lighting', name: '照明設備', category: 'fixed', ratedW: 100, icon: '💡' },
  { id: 'ac', name: '冷氣機', category: 'fixed', ratedW: 1300, icon: '❄️' },
  // 熱水器：本情境設定為瓦斯熱水器（資料集的電熱水器佔整戶 35.5%，遠高於台灣家庭平均 9.55%），不耗電，所以不在用電設備清單裡
]

export const CATEGORY_LABEL = {
  shiftable: '可轉移',
  fixed: '不可轉移',
}

// 各設備配色（圖表用）
// 未分項：RF 預測的不可轉移總量裡，各設備都到合理上限後仍放不下、無法歸到特定設備的部分
export const UNASSIGNED = { id: 'unassigned', name: '未分項', category: 'fixed', ratedW: null, icon: '📦' }

export const DEVICE_COLORS = {
  unassigned: '#94a3b8',
  washer: '#60a5fa',
  dryer: '#818cf8',
  dishwasher: '#22d3ee',
  computer: '#a855f7',
  security: '#c084fc',
  microwave: '#f472b6',
  fridge: '#34d399',
  tv: '#fbbf24',
  lighting: '#fcd34d',
  ac: '#f87171',
}

// ---- 配色（對應各能源流，與 CSS 變數一致）----
export const COLORS = {
  solar: '#ffb020',
  battery: '#22c55e',
  grid: '#3b82f6',
  load: '#a855f7',
  save: '#14b8a6',
  peak: '#ef4444',
  offpeak: '#22c55e',
  charge: '#22c55e',
  discharge: '#f97316',
}
