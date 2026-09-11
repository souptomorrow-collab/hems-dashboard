/**
 * 天氣時間軸（標注在預測圖上方）
 * 以每 3 小時為一格，顯示天氣圖示、狀況、氣溫、降雨機率。
 */
export default function WeatherStrip({ weather }) {
  if (!weather?.summary?.periods) return null
  return (
    <div className="weather-strip">
      {weather.summary.periods.map((p, i) => (
        <div className="ws-block" key={i} title={`${p.range} 時・${p.label}・${p.tempC}°C・降雨 ${p.pop}%`}>
          <div className="ws-time">{p.range}</div>
          <div className="ws-icon">{p.icon}</div>
          <div className="ws-label">{p.label}</div>
          <div className="ws-temp">{p.tempC}°C</div>
          {p.pop > 0 && <div className="ws-pop">💧{p.pop}%</div>}
        </div>
      ))}
    </div>
  )
}
