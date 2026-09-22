import { useState, useEffect, useMemo } from 'react'
import { nowTaipei } from '../lib/time.js'
import { useDemoClock, useDemoEnabled, useDemoSlot, secToDate, slotToDate } from '../lib/demoClock.js'

const slotOfDate = (d) => Math.floor((d.getHours() * 60 + d.getMinutes()) / 15)

/**
 * 每秒更新的時鐘，回傳目前的「台北時間」Date 物件（頁首的時鐘用）。
 *
 * 展示模式開啟時改回傳虛擬時間（見 lib/demoClock.js，以秒為單位）：整個 UI 的即時畫面
 * 都是由這個時間推導的，所以換掉這裡就等於整頁一起加速，
 * 不需要另外寫一套展示用的畫面邏輯。
 * 展示模式下每 0.1 秒更新一次；頁面只需要知道現在第幾格的，請用 useCurrentSlot／useSlotClock。
 */
export function useClock(intervalMs = 1000) {
  const demo = useDemoClock()
  const [now, setNow] = useState(() => nowTaipei())

  useEffect(() => {
    const id = setInterval(() => setNow(nowTaipei()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return demo.enabled ? secToDate(demo.sec, now) : now
}

/**
 * 目前在一天中的第幾格（0~95，每格 15 分鐘）。
 * 展示模式下跟著虛擬時鐘，進到下一格才重畫；真實時間每 5 秒檢查一次。
 * 各頁都靠它決定「過去（真實值）／未來（日前預測）」的分界，
 * 集中在這裡，頁面一和頁面二的分界才保證一致。
 */
export function useCurrentSlot() {
  const demoSlot = useDemoSlot()
  const [real, setReal] = useState(() => slotOfDate(nowTaipei()))
  useEffect(() => {
    const id = setInterval(() => setReal(slotOfDate(nowTaipei())), 5000)
    return () => clearInterval(id)
  }, [])
  return demoSlot >= 0 ? demoSlot : real
}

/**
 * 頁面用的「現在」：換格時才變（一格內的秒數頁面用不到，不必跟著時鐘每 0.1 秒重畫整頁）。
 * 展示模式下是那一格的開頭，真實時間是換格當下的時刻。
 */
export function useSlotClock() {
  const slot = useCurrentSlot()
  const demoOn = useDemoEnabled()
  return useMemo(() => (demoOn ? slotToDate(slot) : nowTaipei()), [slot, demoOn])
}
