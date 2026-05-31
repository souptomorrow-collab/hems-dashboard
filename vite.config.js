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
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
})
