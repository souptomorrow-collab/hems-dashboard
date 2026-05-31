# 家用儲能調度系統 — 顯示與操作介面（HEMS UI）

> 《基於發電量預測之家用儲能調度系統》

以 **React + Vite** 製作的能源管理儀表板前端，對應計畫書第三章「顯示及操作頁面」。
目前以**模擬資料**驅動，並預留 API 接口，日後可接後端（LSTM 太陽能/負載預測、GA 最佳化排程）。

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

## 之後接後端

所有資料都集中在 [`src/api/client.js`](src/api/client.js)。把每個函式內容從「呼叫模擬引擎」改成 `fetch()` 後端 API 即可，UI 不需改動。資料格式可參考 [`src/lib/simulate.js`](src/lib/simulate.js) 的輸出。

## 技術

- React 18 + Vite 5
- react-router-dom（HashRouter）
- ECharts 5（圖表）
- 時間電價：台電 114 年簡易二段式
- 電池規格：Tesla Powerwall 2（13.5 kWh、5 kW、SOC 10–90%）

## 專案結構

```
src/
  api/client.js        ← 資料存取層（換後端只改這裡）
  lib/
    constants.js       ← 時間解析度(15min)、電池、設備、配色
    tou.js             ← 台電時間電價
    simulate.js        ← 能源模擬引擎（PV/負載預測、排程、電池調度）
    charts.js          ← ECharts 共用設定
    format.js          ← 格式化工具
  components/          ← Layout / Panel / StatCard / EChart / EnergyFlow
  pages/               ← Dashboard / Loads / Planning
```
