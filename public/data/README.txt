這個資料夾的內容由程式匯出，不要手改。

一、預測快照（來源 MongoDB，需要連線字串）

  cd 負載預測2
  python mongo_handoff/04_export_web.py --day 2010-11-18
  （把產生的 forecast_day.json 另存成 forecast_day_non_summer.json）
  python mongo_handoff/04_export_web.py --day 2010-09-06

  forecast_day.json               夏月展示日 2010-09-06：負載滾動預測、真實值、太陽能預測與實際
  forecast_day_non_summer.json    非夏月展示日 2010-11-18：同上
  history.json                    歷史紀錄頁用的 14 天（夏月、非夏月各一週）

  順序要照上面：最後一次匯出的展示日會留在 forecast_day.json，那份必須是夏月。

二、排程組的排程（來源 MongoDB hems.schedule，tag=main，需要連線字串）

  cd 專題UI
  python scripts/export_schedule.py

  schedule.json                   排程組的 MILP 排程（目前只有夏月展示日 2010-09-06）
                                  當天電價相符時電池照排程充放電，其他日子用模擬調度

三、天氣（來源 open-meteo ERA5，不需要金鑰）

  cd 專題UI
  python scripts/fetch_weather.py

  weather.json                    history.json 裡每一天的台北逐時天氣（氣溫、濕度、雲量、雨量、晴空指數）

前端由 src/api/forecastData.js 讀取；檔案不在時 UI 會自動退回模擬值。
