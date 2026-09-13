/**
 * 天氣時間軸（標注在預測圖上方）
 * 以每 3 小時為一格，顯示天氣圖示、狀況、氣溫與雨量。
 *
 * 真實天氣（ERA5 再分析資料）只有實際雨量、沒有降雨機率，所以顯示「mm」；
 * 模擬天氣才顯示降雨機率「%」。
 */
export default function WeatherStrip({ weather }) {
  if (!weather?.summary?.periods) return null
  const real = weather.source === 'era5'
  return (
    <div className="weather-strip" aria-label={real ? '當天台北實際天氣（ERA5）' : '模擬天氣'}>
      {weather.summary.periods.map((p, i) => {
        const rain = real
          ? (p.precipMm >= 0.1 ? `${p.precipMm} mm` : null)
          : (p.pop > 0 ? `${p.pop}%` : null)
        const detail = real ? `雨量 ${p.precipMm} mm` : `降雨機率 ${p.pop}%`
        return (
          <div className="ws-block" key={i} title={`${p.range} 時・${p.label}・${p.tempC}°C・${detail}`}>
            <div className="ws-time">{p.range}</div>
            <div className="ws-icon">{p.icon}</div>
            <div className="ws-label">{p.label}</div>
            <div className="ws-temp">{p.tempC}°C</div>
            {rain && <div className="ws-pop">💧{rain}</div>}
          </div>
        )
      })}
    </div>
  )
}
