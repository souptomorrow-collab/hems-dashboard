import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'

// 使用 HashRouter：GitHub Pages 是靜態主機，沒有伺服器端路由設定，
// 用 hash (#/loads) 可以避免重新整理子頁面時出現 404。
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
