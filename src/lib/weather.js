/* ============================================================
   台北天氣模型（模擬）

   目的：讓太陽能發電預測會隨天氣起伏（晴天高、陰雨低、颱風驟降），
   並驅動家庭用電（高溫→冷氣多）。含台北季節特性：
   - 梅雨季（5–6 月）：多陰雨
   - 夏季（7–9 月）：午後雷陣雨
   - 冬季（12–2 月）：東北季風帶來陰雨
   - 颱風（夏秋低機率）：整日強風雨、發電驟降

   真實系統：CWA（中央氣象署）實際天氣 + LSTM 太陽能預測由 Python 後端產生，
   前端只負責顯示。要接真實資料時，改 api/client.js 的 fetchWeather 即可，
   回傳格式比照本檔 simulateWeather() 的輸出。
   ============================================================ */
import { SLOTS_PER_DAY } from './constants.js'
import { mulberry32, seedFromDate, dayOfYear } from './rng.js'

// 天氣狀況：atten = 相對晴空的發電倍率（0~1）；pop = 降雨機率(%)
export const CONDITIONS = {
  sunny: { key: 'sunny', label: '晴', icon: '☀️', atten: 1.0, pop: 0 },
  partly: { key: 'partly', label: '多雲時晴', icon: '🌤️', atten: 0.8, pop: 10 },
  cloudy: { key: 'cloudy', label: '多雲', icon: '☁️', atten: 0.55, pop: 20 },
  overcast: { key: 'overcast', label: '陰', icon: '🌥️', atten: 0.38, pop: 40 },
  rain: { key: 'rain', label: '陣雨', icon: '🌧️', atten: 0.25, pop: 80 },
  heavyRain: { key: 'heavyRain', label: '大雨', icon: '⛈️', atten: 0.15, pop: 95 },
  typhoon: { key: 'typhoon', label: '颱風', icon: '🌀', atten: 0.08, pop: 99 },
}

const DAY_ICON = {
  typhoon: '🌀', rainy: '🌧️', cloudy: '☁️', drizzle: '🌥️',
  afternoonStorm: '⛈️', sunny: '☀️', partly: '🌤️',
}
const DAY_LABEL = {
  typhoon: '颱風來襲', rainy: '有雨', cloudy: '多雲到陰', drizzle: '陰，偶有毛毛雨',
  afternoonStorm: '多雲時晴，午後雷陣雨', sunny: '晴朗', partly: '多雲時晴',
}

// 依當日天氣型態與小時，挑出該小時的天氣狀況
function pickHourCondition(dayType, h, rng) {
  const j = rng()
  switch (dayType) {
    case 'typhoon':
      return 'typhoon'
    case 'rainy': // 梅雨 / 鋒面
      return j < 0.45 ? 'rain' : j < 0.6 ? 'heavyRain' : 'cloudy'
    case 'cloudy':
      return j < 0.6 ? 'cloudy' : j < 0.85 ? 'overcast' : 'partly'
    case 'drizzle': // 冬季陰雨
      if (h >= 4 && h < 12) return j < 0.5 ? 'rain' : 'overcast'
      return j < 0.6 ? 'overcast' : 'cloudy'
    case 'afternoonStorm': // 夏季午後雷陣雨
      if (h >= 13 && h < 18) return j < 0.45 ? 'heavyRain' : j < 0.8 ? 'rain' : 'cloudy'
      if (h >= 11 && h < 13) return j < 0.5 ? 'partly' : 'cloudy'
      return j < 0.55 ? 'sunny' : 'partly'
    case 'sunny':
      return j < 0.75 ? 'sunny' : 'partly'
    case 'partly':
    default:
      return j < 0.45 ? 'partly' : j < 0.75 ? 'sunny' : 'cloudy'
  }
}

/** 產生某日的台北天氣（模擬，決定論：同一天結果固定） */
export function simulateWeather(date) {
  const rng = mulberry32(seedFromDate(date) + 101)
  const m = date.getMonth() + 1
  const doy = dayOfYear(date)
  const tMean = 23 + 8 * Math.cos((2 * Math.PI * (doy - 205)) / 365) // 台北：約 7 月最熱、1 月最冷

  // 決定當日天氣型態（台北季節特性）
  const typhoonProb = m >= 7 && m <= 10 ? 0.03 : 0.004
  let dayType
  const r = rng()
  if (r < typhoonProb) dayType = 'typhoon'
  else if (m === 5 || m === 6) dayType = rng() < 0.5 ? 'rainy' : 'cloudy' // 梅雨季
  else if (m >= 7 && m <= 9) dayType = rng() < 0.55 ? 'afternoonStorm' : 'sunny' // 夏季
  else if (m === 12 || m === 1 || m === 2)
    dayType = rng() < 0.55 ? 'drizzle' : rng() < 0.5 ? 'cloudy' : 'partly' // 冬季東北季風
  else dayType = rng() < 0.6 ? 'sunny' : 'partly' // 春秋

  // 每小時天氣、氣溫、濕度
  const hourly = []
  for (let h = 0; h < 24; h++) {
    const cond = CONDITIONS[pickHourCondition(dayType, h, rng)]
    const diurnal = 4 * Math.sin((2 * Math.PI * (h - 9)) / 24) // 最熱約 15 時、最冷約清晨
    const tempC = +(tMean + diurnal - (1 - cond.atten) * 2.5).toFixed(1)
    const humidity = Math.min(98, Math.max(45, Math.round(66 + (1 - cond.atten) * 30 + (rng() * 6 - 3))))
    hourly.push({ hour: h, ...cond, tempC, humidity })
  }

  // 每 15 分鐘的 PV 衰減倍率與氣溫
  const attenSlots = [], tempSlots = []
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const h = Math.floor((s * 15) / 60)
    const a = hourly[h].atten * (0.95 + rng() * 0.1)
    attenSlots.push(Math.max(0.05, Math.min(1, +a.toFixed(3))))
    tempSlots.push(hourly[h].tempC)
  }

  // 摘要
  const temps = hourly.map((x) => x.tempC)
  const periods = []
  for (let p = 0; p < 8; p++) {
    const mid = hourly[p * 3 + 1]
    periods.push({
      range: `${String(p * 3).padStart(2, '0')}-${String(p * 3 + 3).padStart(2, '0')}`,
      icon: mid.icon, label: mid.label, tempC: mid.tempC, pop: mid.pop,
    })
  }

  return {
    source: 'sim', // 'sim' = 模擬；接後端真實資料時改為 'cwa'
    dayType,
    attenSlots,
    tempSlots,
    hourly,
    summary: {
      label: DAY_LABEL[dayType],
      icon: DAY_ICON[dayType],
      tempMin: Math.min(...temps),
      tempMax: Math.max(...temps),
      popMax: Math.max(...hourly.map((x) => x.pop)),
      periods,
    },
  }
}
