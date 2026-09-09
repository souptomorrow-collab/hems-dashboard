# 家用儲能調度系統 — 顯示與操作介面（HEMS UI）

> 《基於發電量預測之家用儲能調度系統》

以 **React + Vite** 製作的能源管理儀表板前端，對應計畫書第三章「顯示及操作頁面」。

**家庭負載（不可轉移）已接真實資料**：RF 隨機森林的滾動預測結果存在 Supabase，
前端直接查雲端資料表。太陽能發電（LSTM）與 GA 排程仍為模擬引擎，接口已備好。

## 三個頁面

| 頁面 | 內容 |
|------|------|
| **主頁面** | 太陽能即時發電、電池狀態（SOC／充放電功率／即時電量）、家中總負載、電網購電、今日省電費、能源即時流向、今日 24h 功率總覽、**隔日太陽能與負載預測**、最佳化結果摘要 |
| **各負載功率** | 家中各設備即時消耗功率、可轉移／不可轉移分類、即時用電佔比、今日各設備用電堆疊 |
| **用電規劃** | 隔日 24 小時最佳化排程（**以 15 分鐘為單位**）：三種模式（省錢／自用率最大／舒緩夜尖峰）、各設備運行時段甘特表（**可手動調整可轉移設備**）、電池充放電與 SOC、太陽能／電網充電量、向電網購電等 |

## 開發

```bash
npm install      # 安裝相依套件（第一次）
npm run dev      # 啟動開發伺服器，瀏覽器開 http://localhost:5173
```

## 建置

```bash
npm run build    # 產出靜態檔到 dist/
npm run preview  # 本機預覽 build 結果
```

## 部署到 GitHub Pages（已設定自動化）

專案內含 `.github/workflows/deploy.yml`，**push 到 `main` 分支會自動 build 並部署**。

首次設定步驟：

1. 在 GitHub 建立一個新的 repository（例如 `hems-dashboard`）。
2. 在本資料夾執行：
   ```bash
   git remote add origin https://github.com/<你的帳號>/<repo 名稱>.git
   git branch -M main
   git push -u origin main
   ```
3. 到 GitHub repo → **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。
4. 等 Actions 跑完，網址會是 `https://<你的帳號>.github.io/<repo 名稱>/`。

> 採用相對路徑（`base: './'`）與 HashRouter，所以不論 repo 名稱為何、重新整理子頁面都不會 404。

## 資料來源

| 項目 | 來源 | 狀態 |
|------|------|------|
| 不可轉移負載 | Supabase `load_forecast` 表（RF 滾動預測，每 15 分一個 refresh × 96 步） | ✅ 真實 |
| 真實負載（驗證用） | Supabase `actual_load` 表 | ✅ 真實 |
| 太陽能發電 | `simulate.js` 的晴空曲線 × 天氣衰減 | 🧪 模擬 |
| 可轉移設備排程 | `simulate.js` 的最佳視窗搜尋 | 🧪 模擬（待接 GA） |
| 天氣 | `weather.js` | 🧪 模擬（待接 CWA） |

連線設定放環境變數（見 [`.env.example`](.env.example)），不設就用程式內建的專題專案：

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_KEY=<anon key>
```

用的是 **anon（只讀）key**，資料表已開 RLS 只允許 SELECT，放進前端 bundle 是安全的；
可寫的 service_role key 只留在預測端本機，不會進這個 repo。
**雲端連不上時會自動退回模擬負載**，UI 不會壞掉，畫面上的 badge 會標示當下來源。

### 時間軸的處理

資料集是 UCI household_power_consumption（法國 Sceaux 住宅，2010 年 11 月），
時間戳是 2010 年的日期，而 UI 顯示的是當下的今日／明日。兩者這樣接：

取「23:45 發布」的那筆預測（lead 1~96 剛好是隔日 00:00~23:45，整條曲線同一次刷新、
領先步數單調遞增），再**依一日中的時段（0~95）對齊**到畫面當天。曲線形狀完全是模型的
真實輸出，只有日期標籤換掉；接上即時資料後這層對齊即可移除。

另外 RF 預測的是不可轉移負載的**總量**，拆不出各設備。頁面二的設備堆疊圖是把
各不可轉移設備按比例縮放以吻合該總量——屬於顯示用的分解，不是模型輸出（`simulate.js` 內有註明）。

## 之後接後端

其餘資料都集中在 [`src/api/client.js`](src/api/client.js)。把對應函式內容從「呼叫模擬引擎」改成 `fetch()` 後端 API 即可，UI 不需改動。資料格式可參考 [`src/lib/simulate.js`](src/lib/simulate.js) 的輸出。

## 技術

- React 18 + Vite 5
- react-router-dom（HashRouter）
- ECharts 5（圖表）
- 時間電價：台電 114 年簡易二段式
- 電池規格：Tesla Powerwall 2（13.5 kWh、5 kW、SOC 10–90%）

## 專案結構

```
src/
  api/
    client.js          ← 資料存取層（換後端只改這裡）
    supabase.js        ← Supabase/PostgREST 讀取（負載預測資料）
  lib/
    constants.js       ← 時間解析度(15min)、電池、設備、配色
    tou.js             ← 台電時間電價
    simulate.js        ← 能源模擬引擎（太陽能曲線、排程、電池調度）
    loadForecast.js    ← 預測資料整形（另含誤差指標 MAE/RMSE/R²/MAPE，
                          供日後的預測驗證頁使用，目前未接頁面）
    charts.js          ← ECharts 共用設定
    format.js          ← 格式化工具
  components/          ← Layout / Panel / StatCard / EChart / EnergyFlow
  pages/               ← Dashboard / Loads / Planning
```
