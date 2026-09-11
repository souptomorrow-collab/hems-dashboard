import { useState, useEffect } from 'react'
import { nowTaipei } from '../lib/time.js'
import { useDemoClock, slotToDate } from '../lib/demoClock.js'

/**
 * 每秒更新的時鐘，回傳目前的「台北時間」Date 物件。
 *
 * 展示模式開啟時改回傳虛擬時間（見 lib/demoClock.js）：整個 UI 的即時畫面
 * 都是由這個時間推導的，所以換掉這裡就等於整頁一起加速，
 * 不需要另外寫一套展示用的畫面邏輯。
 */
export function useClock(intervalMs = 1000) {
  const demo = useDemoClock()
  const [now, setNow] = useState(() => nowTaipei())

  useEffect(() => {
    const id = setInterval(() => setNow(nowTaipei()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return demo.enabled ? slotToDate(demo.slot, now) : now
}

/**
 * 目前在一天中的第幾格（0~95，每格 15 分鐘）。
 * 展示模式下 useClock() 已經回傳虛擬時間，所以同一條公式兩種模式都適用。
 * 各頁都靠它決定「過去／未來」的分界與滾動預測要取哪一筆，
 * 集中在這裡，頁面一和頁面二的分界才保證一致。
 */
export function useCurrentSlot() {
  const now = useClock()
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / 15)
}
