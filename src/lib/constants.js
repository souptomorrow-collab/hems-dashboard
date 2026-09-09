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
  // 可轉移
  { id: 'washer', name: '洗衣機', category: 'shiftable', ratedW: 500, icon: '🧺' },
  { id: 'dryer', name: '烘衣機', category: 'shiftable', ratedW: 1500, icon: '🌀' },
  { id: 'waterHeater', name: '熱水器', category: 'shiftable', ratedW: 2000, icon: '🚿' },
  { id: 'dishwasher', name: '洗碗機', category: 'shiftable', ratedW: 1200, icon: '🍽️' },
  // 不可轉移
  { id: 'computer', name: '電腦', category: 'fixed', ratedW: 250, icon: '💻' },
  { id: 'security', name: '監控設備', category: 'fixed', ratedW: 40, icon: '📹' },
  { id: 'microwave', name: '微波爐', category: 'fixed', ratedW: 1000, icon: '🍱' },
  { id: 'fridge', name: '冰箱', category: 'fixed', ratedW: 150, icon: '🧊' },
  { id: 'tv', name: '電視', category: 'fixed', ratedW: 120, icon: '📺' },
  { id: 'lighting', name: '照明設備', category: 'fixed', ratedW: 200, icon: '💡' },
  { id: 'ac', name: '冷氣機', category: 'fixed', ratedW: 1400, icon: '❄️' },
]

export const CATEGORY_LABEL = {
  shiftable: '可轉移',
  fixed: '不可轉移',
}

// 各設備配色（圖表用）
export const DEVICE_COLORS = {
  washer: '#60a5fa',
  dryer: '#818cf8',
  waterHeater: '#38bdf8',
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
