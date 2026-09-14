import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Loads from './pages/Loads.jsx'
import Planning from './pages/Planning.jsx'
import History from './pages/History.jsx'
import System from './pages/System.jsx'
import Login from './pages/Login.jsx'
import { useAuth } from './lib/auth.js'

export default function App() {
  const session = useAuth()
  // 沒登入就只顯示登入頁。網址不動，登入後會直接進到原本要去的那一頁（例如分享出去的 #/history）
  if (!session) return <Login />
  const admin = session.role === 'admin'
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="loads" element={<Loads />} />
        <Route path="planning" element={<Planning />} />
        <Route path="history" element={<History />} />
        {/* 系統資訊只給管理員；住戶直接打網址也會被導回主頁面 */}
        <Route path="system" element={admin ? <System /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
