import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
// 在 React 掛載前就把 data-theme 套到 <html>，避免先閃一下夜間色
import './lib/theme.js'

// 使用 HashRouter：GitHub Pages 是靜態主機，沒有伺服器端路由設定，
// 用 hash (#/loads) 可以避免重新整理子頁面時出現 404。
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* 先開啟 React Router v7 的兩個新行為，開發模式就不會一直提醒。
        本專案的路由都是絕對路徑（萬用路由只做 Navigate to="/"），兩個變更都不影響 */}
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
