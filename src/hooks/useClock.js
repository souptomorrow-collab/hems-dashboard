import { useState, useEffect, useMemo } from 'react'
import { nowTaipei } from '../lib/time.js'
import { useDemoClock, useDemoEnabled, useDemoSlot, secToDate, slotToDate } from '../lib/demoClock.js'
import { useScenario, todayOf } from '../lib/scenario.js'

const slotOfDate = (d) => Math.floor((d.getHours() * 60 + d.getMinutes()) / 15)

/** 真實時間的時分秒，日期換成展示月的今天（平常模式循環到的那一天，見 scenario.js 的 todayOf） */
function onDatasetDay(t, season) {
  const [y, m, d] = todayOf(season).split('-').map(Number)
  const out = new Date(t)
  out.setFullYear(y, m - 1, d)
  return out
}

/**
 * 每秒更新的時鐘，回傳目前的時間 Date 物件（頁首的時鐘用），日期一律是展示月的日子。
 *
 * 平常：時分秒是真實的台北時間，日期是展示月循環到的那一天（例如 2010-07-24）。
 * 展示模式開啟時改回傳虛擬時間（見 lib/demoClock.js，以秒為單位）：整個 UI 的即時畫面
 * 都是由這個時間推導的，所以換掉這裡就等於整頁一起加速，
 * 不需要另外寫一套展示用的畫面邏輯。
 * 展示模式下每 0.1 秒更新一次，日期是播放中的資料集日期（例如 2010-07-04）；
 * 頁面只需要知道現在第幾格的，請用 useCurrentSlot／useSlotClock。
 */
export function useClock(intervalMs = 1000) {
  const demo = useDemoClock()
  const { season } = useScenario()
  const [now, setNow] = useState(() => nowTaipei())

  useEffect(() => {
    const id = setInterval(() => setNow(nowTaipei()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  if (!demo.enabled) return onDatasetDay(now, season)
  const [y, m, d] = todayOf(season, demo).split('-').map(Number)
  return secToDate(demo.sec, new Date(y, m - 1, d))
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
 * 展示模式下是那一格的開頭，平常是換格當下的時刻；日期都是展示月的今天。
 */
export function useSlotClock() {
  const slot = useCurrentSlot()
  const demoOn = useDemoEnabled()
  const { season } = useScenario()
  return useMemo(() => onDatasetDay(demoOn ? slotToDate(slot) : nowTaipei(), season), [slot, demoOn, season])
}
