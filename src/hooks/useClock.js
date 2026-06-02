import { useState, useEffect } from 'react'
import { nowTaipei } from '../lib/time.js'

/** 每秒更新的時鐘，回傳目前的「台北時間」Date 物件。 */
export function useClock(intervalMs = 1000) {
  const [now, setNow] = useState(() => nowTaipei())
  useEffect(() => {
    const id = setInterval(() => setNow(nowTaipei()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
