import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Loads from './pages/Loads.jsx'
import Planning from './pages/Planning.jsx'
import Forecast from './pages/Forecast.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="loads" element={<Loads />} />
        <Route path="planning" element={<Planning />} />
        <Route path="forecast" element={<Forecast />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
