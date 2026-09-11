# 家庭能源管理系統 — 顯示與操作介面（HEMS UI）

> 《基於發電量與負載預測之家庭能源管理系統》（組別 A04-1151）

以 **React + Vite** 製作的能源管理儀表板前端，對應計畫書第三章「顯示及操作頁面」。

**家庭負載（不可轉移）已接真實資料**：RF 隨機森林的滾動預測結果存在 MongoDB Atlas，
由預測端匯出成靜態快照隨網站部署（原因見下方「資料來源」）。
太陽能發電（LSTM）與 GA 排程仍為模擬引擎，接口已備好。

## 三個頁面

| 頁面 | 內容 |
|------|------|
| **主頁面** | 太陽能即時發電、電池狀態（SOC／充放電功率／即時電量）、家中總負載、電網購電、今日省電費、能源即時流向、**即時運轉**（只畫到現在）、**今日預測與排程**（全天）、**不可轉移負載滾動預測**。隔日的內容集中在「用電規劃」頁 |
| **各負載功率** | 家中各設備即時消耗功率、可轉移／不可轉移分類、即時用電佔比、今日各設備用電堆疊 |
| **用電規劃** | 隔日 24 小時最佳化排程（**以 15 分鐘為單位**，最佳化目標為電費最小化）：各設備運行時段甘特表（**可手動調整可轉移設備**）、電池充放電與 SOC、太陽能／電網充電量、向電網購電等 |
| **歷史紀錄** | 逐日查詢（資料集 2010-11-18～24 共 7 天）：不可轉移負載的**真實值 vs 日前預測 vs 一步預測**與 MAE／RMSE／MAPE、以當日真實負載模擬的 HEMS 運轉與電費、七日總覽表。可**匯出當日明細 CSV、七日摘要 CSV、列印／另存 PDF** |

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

## 歷史紀錄與報表匯出

資料來自 `public/data/history.json`（由 `mongo_handoff/04_export_web.py` 從 MongoDB 匯出），
只收「真實值、日前預測、一步預測三條都齊全」的日子。

| 項目 | 來源 |
|---|---|
| 不可轉移負載真實值、預測、誤差指標 | MongoDB 實際紀錄 |
| 太陽能、電池、電網、電費 | 以當日真實負載餵模擬引擎（標示「模擬」） |

- **日前預測**：前一晚 23:45 發布，是排程時手上有的預測
- **一步預測**：每格取前一格發布、只看 15 分鐘後的值
- 兩者是預測距離的兩端，並排才看得出「越近越準」實際差多少（七日平均 MAE 0.155 → 0.107 kW）

匯出：
- **CSV** 開頭帶 UTF-8 BOM，Excel 直接開中文表頭不會亂碼
- **PDF** 走瀏覽器列印（`@media print` 隱藏側欄、頂端列與按鈕）；夜間模式會先暫時切到日間再印，白紙上才看得清楚

> 週末的省電費明顯較低（約 4～6 元 vs 平日 25～35 元）不是錯誤：台電簡易二段式電價
> 週末全天離峰，沒有尖離峰價差，電池就沒有套利空間。

## 滾動預測

RF 是**滾動預測**：每 15 分鐘重跑一次、重發未來 96 步，所以同一個時刻會被
預測很多次，越接近越更新。以 2010-11-23 20:00 為例：

| 發布時間 | 領先步數 | 預測值 |
|---|---|---|
| 08:00 | 48 | 0.6305 kW |
| 12:00 | 32 | 0.6200 kW |
| 16:00 | 16 | 0.6095 kW |
| 19:00 | 4 | 0.5099 kW |
| 真實值 | — | 1.0760 kW |

UI 會重現這個行為。在第 *s* 格時：

- **過去（0～s）**：用當天**真實值**
- **未來（s+1～95）**：用「在第 *s* 格發布」的那次預測

排程與電池調度跟著重算，但只影響未來——`dispatch()` 是照時間順序推的，
過去那段吃的是不會變的真實值，所以已經發生的軌跡自然凍住，不需另外處理。

快照 `public/data/forecast_day.json` 因此包含一個 96×96 的矩陣
（`rolling[s][k]` = 第 s 格發布、領先 k+1 步），約 110 KB。

> kW 軸刻意設計成「只增不減」。滾動時每格換一次資料，若讓軸自動縮放，
> 播放時整張圖會不停上下跳，前後時刻也無法比較。

## 展示模式（期末口試用）

主頁面最上方有一條控制列。開啟後把**一天壓縮成 96 秒**播完——排程的解析度是
15 分鐘、一天 96 格，**一格對應一秒**（也可切 2×／4×）。可暫停、重播，
或直接拖進度條跳到想講的時段。

做法是「換掉時鐘」而不是另外寫一套展示畫面：整個 UI 的即時區塊本來就由
`useClock()` 給的時間推導（`liveSnapshot(now)` 依 now 算出目前在第幾格，
再取該格的排程、發電、電池狀態），所以時鐘一加速，能源流向、KPI 卡、
設備開關、尖離峰電價標示、頁面二的各設備功率就會一起跑，
不會有「展示用的假畫面」和「真的畫面」兩套邏輯要同步。

日期沿用今天、只換時分，電價的夏月／平日假日判斷才不會跑掉。
「今日功率總覽」上會有一條播放頭標出目前播到哪。

實作在 [`src/lib/demoClock.js`](src/lib/demoClock.js) 與
[`src/components/DemoBar.jsx`](src/components/DemoBar.jsx)。

## 主題

右上角可切換**日間／夜間**。使用者沒選過時跟隨系統偏好，選過就記在 localStorage。
顏色全部走 CSS 變數；ECharts 不吃 CSS 變數，另由
[`src/lib/charts.js`](src/lib/charts.js) 的 `applyChartTheme()` 換色，
各頁圖表的 `useMemo` 相依陣列帶著 `useTheme()`，主題一換就重算。

## 資料來源

| 項目 | 來源 | 狀態 |
|------|------|------|
| 不可轉移負載 | MongoDB `hems.load_forecast`（RF 滾動預測，每 15 分一個 refresh × 96 步） | ✅ 真實 |
| 真實負載（驗證用） | MongoDB `hems.actual_load` | ✅ 真實 |
| 太陽能發電 | `simulate.js` 的晴空曲線 × 天氣衰減 | 🧪 模擬 |
| 可轉移設備排程 | `simulate.js` 的最佳視窗搜尋 | 🧪 模擬（待接 GA） |
| 天氣 | `weather.js` | 🧪 模擬（待接 CWA） |

### 資料庫的資料怎麼進到這個 repo

前端**不直接連 MongoDB**。MongoDB 只接受官方 driver（TCP + TLS + SCRAM），
瀏覽器發不出這種連線；Atlas 過去提供的 Data API 也已於 2025-09-30 停止服務。
更關鍵的是 MongoDB 的連線字串是一把全開的鑰匙，沒有唯讀權限層可以套，
放進前端 bundle 等於把資料庫交出去。

所以改成**發布快照**：資料庫仍是唯一來源，由預測端匯出成靜態 JSON 一起部署。

```powershell
# 在 負載預測2/ 底下
python mongo_handoff/04_export_web.py     # → 專題UI/public/data/forecast_day.json
```

前端讀的就是這個檔（[`src/api/forecastData.js`](src/api/forecastData.js)）：同源、
免金鑰、沒有 CORS，也不會再遇到免費版資料庫冷啟動害前端逾時。
代價是資料庫更新後要重跑匯出並重新部署——本專題用的是固定的歷史資料集，這個代價等於零。

**讀不到快照時會自動退回模擬負載**，UI 不會壞掉，畫面上的 badge 會標示當下來源。

日後真的要即時資料，把 `forecastData.js` 的 `DATA_URL` 指向後端 API 即可，回傳格式不變。

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
- 電池規格：Tesla Powerwall 2（13.5 kWh、5 kW、SOC 15–90%，初始 15%）

## 專案結構

```
src/
  api/
    client.js          ← 資料存取層（換後端只改這裡）
    forecastData.js    ← 讀 public/data/forecast_day.json（MongoDB 匯出的快照）
  lib/
    constants.js       ← 時間解析度(15min)、電池、設備、配色
    tou.js             ← 台電時間電價
    simulate.js        ← 能源模擬引擎（太陽能曲線、排程、電池調度）
    charts.js          ← ECharts 共用設定
    format.js          ← 格式化工具
  components/          ← Layout / Panel / StatCard / EChart / EnergyFlow
  pages/               ← Dashboard / Loads / Planning
```
