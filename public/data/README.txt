這個資料夾的內容由程式匯出，不要手改。
網站平常直接讀後端 API（hems-api）；這裡的檔案是 API 連不上時的備援快照。

一、預測、歷史紀錄、排程（來源：後端 API，不需要連線字串）

  cd 專題UI
  python scripts/export_snapshots.py

  forecast_day.json               夏月展示日 2010-09-06：負載滾動預測、真實值、太陽能預測與實際
  forecast_day_non_summer.json    非夏月展示日 2010-11-18：同上
  history.json                    歷史紀錄頁用的一整年（2009-11-26 ~ 2010-11-25）：真實值、日前預測、一步預測；
                                  太陽能預測只有兩個展示週（夏月、非夏月各一週）
  schedule.json                   排程組的 MILP 排程（tag=main；目前只有夏月展示日 2010-09-06）
                                  當天電價相符時電池照排程充放電，其他日子用模擬調度

  資料庫改成 hems_db 第 2 版格式（2026-09-17）後，負載預測共用 repo 的
  mongo_handoff/04_export_web.py 讀不懂新格式，不要再用它匯出。

二、天氣（來源 open-meteo ERA5，不需要金鑰）

  cd 專題UI
  python scripts/fetch_weather.py

  weather.json                    台北逐時天氣（氣溫、濕度、雲量、雨量、晴空指數）。
                                  目前只有兩個展示週 14 天；重跑會抓 history.json 裡的每一天（一整年）

前端由 src/api/forecastData.js 讀取；檔案不在時 UI 會自動退回模擬值。
