import { useEffect, useState } from 'react'
import { DATA_REFRESHED } from '../api/forecastData.js'

/** 本機重算時每寫回新的日子就加一（Layout 發 DATA_REFRESHED）。放進 useEffect 的相依，頁面就會重抓那天的資料，
    不必等整個月算完、也不必重新整理 */
export function useDataRevision() {
  const [rev, setRev] = useState(0)
  useEffect(() => {
    const bump = () => setRev((r) => r + 1)
    window.addEventListener(DATA_REFRESHED, bump)
    return () => window.removeEventListener(DATA_REFRESHED, bump)
  }, [])
  return rev
}
