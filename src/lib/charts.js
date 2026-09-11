/* ECharts 共用設定：15 分鐘時間軸、隨主題切換的座標軸顏色 */
import { SLOTS_PER_DAY, slotToTime } from './constants.js'

/* ------------------------------------------------------------
   主題色

   ECharts 的顏色是寫進 option 物件的字串，不吃 CSS 變數，所以頁面
   換主題時得另外把這幾個值換掉。這裡宣告成 let 並由 applyChartTheme()
   改寫 —— ES module 的匯出是「即時繫結」，import 端看到的一定是最新值。

   換完值還要讓 option 重算才會生效：各頁的 useMemo 相依陣列裡都放了
   useTheme()，主題一變就會重跑（useMemo 重算不會重置元件狀態，
   所以使用者在頁面三手動調過的排程不會被清掉）。
   ------------------------------------------------------------ */
const PALETTE = {
  dark: {
    axis: '#9aa4bd',
    split: 'rgba(255,255,255,0.06)',
    tipBg: 'rgba(20,26,46,0.95)',
    tipBorder: 'rgba(255,255,255,0.12)',
    tipText: '#e8edf7',
    pointer: 'rgba(255,255,255,0.25)',
    pageInactive: 'rgba(255,255,255,0.2)',
    text: '#e8edf7',
    track: 'rgba(255,255,255,0.08)',
    trackLine: 'rgba(255,255,255,0.15)',
  },
  light: {
    axis: '#5a6478',
    split: 'rgba(15,23,42,0.10)',
    tipBg: 'rgba(255,255,255,0.97)',
    tipBorder: 'rgba(15,23,42,0.12)',
    tipText: '#1a2233',
    pointer: 'rgba(15,23,42,0.25)',
    pageInactive: 'rgba(15,23,42,0.2)',
    text: '#1a2233',
    track: 'rgba(15,23,42,0.10)',
    trackLine: 'rgba(15,23,42,0.18)',
  },
}

export let AXIS_TEXT = PALETTE.dark.axis
export let SPLIT_LINE = PALETTE.dark.split
export let TEXT_MAIN = PALETTE.dark.text        // 圖上的主要數字（例如儀表中央的百分比）
export let TRACK = PALETTE.dark.track           // 儀表底環
export let TRACK_LINE = PALETTE.dark.trackLine  // 儀表刻度線
export let baseTooltip = {}
export let baseLegend = {}

export function applyChartTheme(theme) {
  const c = PALETTE[theme] ?? PALETTE.dark
  AXIS_TEXT = c.axis
  SPLIT_LINE = c.split
  TEXT_MAIN = c.text
  TRACK = c.track
  TRACK_LINE = c.trackLine
  baseTooltip = {
    trigger: 'axis',
    backgroundColor: c.tipBg,
    borderColor: c.tipBorder,
    textStyle: { color: c.tipText, fontSize: 12 },
    axisPointer: { type: 'line', lineStyle: { color: c.pointer } },
  }
  baseLegend = {
    textStyle: { color: c.axis, fontSize: 12 },
    icon: 'roundRect',
    itemWidth: 14,
    itemHeight: 8,
    top: 0,
    // 窄螢幕下圖例若折成兩行，會往下壓到座標軸標籤；改用可捲動的單行圖例。
    type: 'scroll',
    pageIconColor: c.axis,
    pageIconInactiveColor: c.pageInactive,
    pageTextStyle: { color: c.axis, fontSize: 11 },
  }
}

applyChartTheme('dark') // 先給預設值；theme.js 載入時會依實際主題再套一次

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

// top 需留給圖例（top:0）與 Y 軸軸名兩層，否則窄螢幕下軸名會疊在圖例上
export const baseGrid = { left: 48, right: 20, top: 54, bottom: 28 }

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

