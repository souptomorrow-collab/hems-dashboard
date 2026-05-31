/* ECharts 共用設定：深色主題、15 分鐘時間軸 */
import { SLOTS_PER_DAY, slotToTime } from './constants.js'

export const AXIS_TEXT = '#9aa4bd'
export const SPLIT_LINE = 'rgba(255,255,255,0.06)'

/** 96 個時段的時間標籤 "HH:MM" */
export const slotLabels = Array.from({ length: SLOTS_PER_DAY }, (_, s) =>
  slotToTime(s)
)

/** 15 分鐘類別 X 軸（每 2 小時顯示一個刻度） */
export function slotXAxis(extra = {}) {
  return {
    type: 'category',
    data: slotLabels,
    boundaryGap: extra.boundaryGap ?? false,
    axisLine: { lineStyle: { color: SPLIT_LINE } },
    axisTick: { show: false },
    axisLabel: {
      color: AXIS_TEXT,
      interval: 7, // 每 8 格(=2h)顯示一次
      fontSize: 11,
    },
    ...extra,
  }
}

export function valueYAxis(name, extra = {}) {
  return {
    type: 'value',
    name,
    nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
    axisLabel: { color: AXIS_TEXT, fontSize: 11 },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: SPLIT_LINE } },
    ...extra,
  }
}

export const baseTooltip = {
  trigger: 'axis',
  backgroundColor: 'rgba(20,26,46,0.95)',
  borderColor: 'rgba(255,255,255,0.12)',
  textStyle: { color: '#e8edf7', fontSize: 12 },
  axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.25)' } },
}

export const baseLegend = {
  textStyle: { color: AXIS_TEXT, fontSize: 12 },
  icon: 'roundRect',
  itemWidth: 14,
  itemHeight: 8,
  top: 0,
}

export const baseGrid = { left: 48, right: 20, top: 40, bottom: 28 }

/** 把 tier 陣列轉成「尖峰時段」的 markArea 資料（淡紅底色） */
export function peakMarkArea(tier) {
  const areas = []
  let start = null
  for (let i = 0; i < tier.length; i++) {
    if (tier[i] === 'peak' && start === null) start = i
    if ((tier[i] !== 'peak' || i === tier.length - 1) && start !== null) {
      const end = tier[i] === 'peak' ? i : i - 1
      areas.push([{ xAxis: slotLabels[start] }, { xAxis: slotLabels[end] }])
      start = null
    }
  }
  return {
    silent: true,
    itemStyle: { color: 'rgba(239,68,68,0.08)' },
    data: areas,
  }
}
