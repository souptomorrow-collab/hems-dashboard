這個資料夾的內容由程式匯出，不要手改。
網站平常直接讀後端 API（hems-api）；這裡的檔案是 API 連不上時的備援快照。

一、預測、歷史紀錄、排程（來源：後端 API，不需要連線字串）

  cd 專題UI
  python scripts/export_snapshots.py

  forecast_day.json               夏月展示日 2010-07-19：負載滾動預測、真實值、太陽能預測與實際
  forecast_day_non_summer.json    非夏月展示日 2010-01-11：同上
  history.json                    歷史紀錄頁用的一整年（2009-11-26 ~ 2010-11-25）：真實值、日前預測、一步預測
  schedule.json                   日前排程（tag=main）：兩個展示月（2010-01、2010-07）每天一份，
                                  排程組的 MILP 前一晚 23:45 把電池與可轉移設備一起排
  operation.json                  實時運轉層每 15 分鐘的紀錄（兩個展示月）
  plans/YYYY-MM-DD.json           實時運轉層每 15 分鐘重排的計畫（tag=rolling），一天一檔、96 份，
                                  每份往後 24 小時；主頁面「未來 24 小時預測與排程」讀這個
  realtime/YYYY-MM-DD.json        秒級重播（兩個展示月每天一檔，scripts/make_realtime_snapshot.py 產生）

  資料庫改成 hems_db 第 2 版格式（2026-09-17）後，負載預測共用 repo 的
  mongo_handoff/04_export_web.py 讀不懂新格式，不要再用它匯出。

二、天氣（來源 open-meteo ERA5，不需要金鑰）

  cd 專題UI
  python scripts/fetch_weather.py

  weather.json                    台北逐時天氣（氣溫、濕度、雲量、雨量、晴空指數），兩個展示月 62 天

前端由 src/api/forecastData.js 讀取；檔案不在時 UI 會自動退回模擬值。
