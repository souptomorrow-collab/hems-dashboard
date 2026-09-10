這個資料夾的內容由 MongoDB 匯出，不要手改。

  cd 負載預測2
  python mongo_handoff/04_export_web.py

會產生 forecast_day.json（隔日預測的 96 格）。
前端由 src/api/forecastData.js 讀取；檔案不在時 UI 會自動退回模擬負載。
