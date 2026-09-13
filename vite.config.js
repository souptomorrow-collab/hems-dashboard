import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' 使用相對路徑，這樣不論部署到 GitHub Pages 的哪個 repo 路徑
// (https://<帳號>.github.io/<repo>/) 都能正確載入資源，不用寫死 repo 名稱。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
  },
  build: {
    // echarts 分塊按需載入後約 560 KB（gzip 約 190 KB），是刻意獨立出來方便快取的函式庫，
    // 預設 500 KB 的警告門檻對它沒有意義
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 用函式分塊：EChart.jsx 改成從 echarts/core 按需載入後，
        // 物件寫法的 ['echarts'] 會把整包入口重新拉進來，按需載入就白做了
        manualChunks(id) {
          if (/node_modules[\\/](echarts|zrender)[\\/]/.test(id)) return 'echarts'
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run)[\\/]/.test(id)) return 'react'
        },
      },
    },
  },
})
