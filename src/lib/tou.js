/* ============================================================
   時間電價（台電 114 年・簡易二段式）
   對應計畫書表 3
   單位：元 / 度(kWh)
   ============================================================ */
import { SLOTS_PER_DAY, slotToHour } from './constants.js'

export const PRICE = {
  summer: { peak: 5.16, offpeak: 2.06 },
  nonSummer: { peak: 4.93, offpeak: 1.99 },
}

/** 是否為夏月（6/1 ~ 9/30） */
export function isSummer(date) {
  const m = date.getMonth() + 1 // 1~12
  return m >= 6 && m <= 9
}

/** 是否為週六、週日（簡化：不含國定離峰日） */
export function isWeekend(date) {
  const d = date.getDay() // 0 = 週日, 6 = 週六
  return d === 0 || d === 6
}

/**
 * 取得某日某小時的電價時段與單價。
 * @returns { tier: 'peak' | 'offpeak', price: number }
 */
export function getTierByHour(date, hour) {
  const summer = isSummer(date)
  const rate = summer ? PRICE.summer : PRICE.nonSummer

  // 週六日及離峰日：全日離峰
  if (isWeekend(date)) {
    return { tier: 'offpeak', price: rate.offpeak }
  }

  // 平日
  let isPeak
  if (summer) {
    // 夏月平日尖峰 09:00~24:00
    isPeak = hour >= 9
  } else {
    // 非夏月平日尖峰 06:00~11:00、14:00~24:00
    isPeak = (hour >= 6 && hour < 11) || (hour >= 14)
  }
  return isPeak
    ? { tier: 'peak', price: rate.peak }
    : { tier: 'offpeak', price: rate.offpeak }
}

/** 依目前時間取得時段（給頂部列顯示用） */
export function getCurrentTier(date) {
  return getTierByHour(date, date.getHours())
}

/** 一整天 96 個 15 分鐘時段的電價陣列 */
export function getPriceSlots(date) {
  return Array.from({ length: SLOTS_PER_DAY }, (_, slot) =>
    getTierByHour(date, slotToHour(slot)).price
  )
}

/** 一整天 96 個時段的時段別陣列 ('peak' | 'offpeak') */
export function getTierSlots(date) {
  return Array.from({ length: SLOTS_PER_DAY }, (_, slot) =>
    getTierByHour(date, slotToHour(slot)).tier
  )
}

export const TIER_LABEL = { peak: '尖峰', offpeak: '離峰' }
