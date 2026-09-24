/* ECharts 共用設定：15 分鐘時間軸、隨主題切換的座標軸顏色 */
import { SLOTS_PER_DAY, slotToTime, setDeviceColors } from './constants.js'

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
    dim: '#7f8aa8', // 和 CSS 的 --text-dim 相同
    split: 'rgba(255,255,255,0.06)',
    tipBg: 'rgba(20,26,46,0.95)',
    tipBorder: 'rgba(255,255,255,0.12)',
    tipText: '#e8edf7',
    pointer: 'rgba(255,255,255,0.25)',
    pageInactive: 'rgba(255,255,255,0.2)',
    text: '#e8edf7',
    track: 'rgba(255,255,255,0.08)',
    trackLine: 'rgba(255,255,255,0.15)',
    panel: '#141a2e',
  },
  light: {
    axis: '#5a6478',
    dim: '#667085',
    split: 'rgba(15,23,42,0.10)',
    tipBg: 'rgba(255,255,255,0.97)',
    tipBorder: 'rgba(15,23,42,0.12)',
    tipText: '#1a2233',
    pointer: 'rgba(15,23,42,0.25)',
    pageInactive: 'rgba(15,23,42,0.2)',
    text: '#1a2233',
    track: 'rgba(15,23,42,0.10)',
    trackLine: 'rgba(15,23,42,0.18)',
    panel: '#ffffff',
  },
}

export let AXIS_TEXT = PALETTE.dark.axis
export let DIM_TEXT = PALETTE.dark.dim // 次要的標籤（例如沒在運轉的設備）
export let SPLIT_LINE = PALETTE.dark.split
export let TEXT_MAIN = PALETTE.dark.text        // 圖上的主要數字（例如儀表中央的百分比）
export let TRACK = PALETTE.dark.track           // 儀表底環
export let TRACK_LINE = PALETTE.dark.trackLine  // 儀表刻度線
// 面板底色。圖表畫在 canvas 上，不認得 'var(--bg-panel)' 這種 CSS 變數，
// 寫進去會解析失敗而退回黑色——圓餅圖的扇形分隔線原本就是這樣變成一圈黑框的。
export let PANEL_BG = PALETTE.dark.panel
export let baseTooltip = {}
export let baseLegend = {}

export function applyChartTheme(theme) {
  const c = PALETTE[theme] ?? PALETTE.dark
  AXIS_TEXT = c.axis
  DIM_TEXT = c.dim
  SPLIT_LINE = c.split
  TEXT_MAIN = c.text
  TRACK = c.track
  TRACK_LINE = c.trackLine
  PANEL_BG = c.panel
  setDeviceColors(theme === 'light' ? 'light' : 'dark') // 設備配色也分日間／夜間兩組
  baseTooltip = {
    trigger: 'axis',
    backgroundColor: c.tipBg,
    borderColor: c.tipBorder,
    textStyle: { color: c.tipText, fontSize: 12 },
    axisPointer: { type: 'line', lineStyle: { color: c.pointer } },
  }
  baseLegend = {
    textStyle: { color: c.axis, fontSize: 12 },
    // 不指定 icon：ECharts 會依系列種類畫圖示——折線畫成線（虛線系列也是虛線）、長條畫成方塊，
    // 圖例才分得出「SOC 曲線」和「電池充電長條」，兩個都是綠色時也不會搞混
    itemWidth: 18,
    itemHeight: 10,
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
      hideOverlap: true, // 手機寬度放不下時自動略過重疊的標籤，不會擠成一串
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

/* ------------------------------------------------------------
   功率＋SOC：上下兩格共用時間軸

   原本 SOC（%）疊在 kW 圖右側的第二條 y 軸：兩把尺各自縮放，
   SOC 曲線會穿過電池放電的負值長條，看起來像 SOC 變成負的，兩條線的高低關係也沒有意義。
   改成上面一格畫功率（kW）、下面一小格畫 SOC（%），x 軸對齊，
   滑鼠移到任一格時兩格的十字線與提示框一起動。
   用法：{ ...powerSocLayout(), yAxis: [valueYAxis('kW'), socYAxis()] }，
        SOC 系列加 xAxisIndex: 1, yAxisIndex: 1；EChart 高度多加 SOC_EXTRA_HEIGHT。
   ------------------------------------------------------------ */
const SOC_H = 70 // SOC 小圖高度
const SOC_GAP = 30 // 兩格之間的距離（放 SOC 軸名）
export const SOC_EXTRA_HEIGHT = SOC_H + SOC_GAP
/** 自訂 SOC 小圖高度時，EChart 要多加的高度 */
export const socExtraHeight = (socH) => socH + SOC_GAP

// 右邊留 32px：SOC 小圖右端有 90%／15% 參考線標籤，24px 會切掉「%」的右半邊
export function powerSocLayout({ right = 32, boundaryGap, socH = SOC_H } = {}) {
  // boundaryGap 沒指定就不要傳：slotXAxis 會把 undefined 蓋上去，類別軸就變回預設的留邊
  const bg = boundaryGap == null ? {} : { boundaryGap }
  return {
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: baseGrid.left, right, top: baseGrid.top, bottom: baseGrid.bottom + socH + SOC_GAP },
      { left: baseGrid.left, right, height: socH, bottom: baseGrid.bottom },
    ],
    xAxis: [
      slotXAxis({ gridIndex: 0, ...bg, axisLabel: { show: false } }),
      slotXAxis({ gridIndex: 1, ...bg }),
    ],
  }
}

/**
 * 功率＋SOC 圖的提示框：兩格的資料合在同一個框、時間只列一次，
 * 功率標 kW（放電畫成負值長條，但數字寫正的）、SOC 標 %，SOC 排最後。
 */
export function powerSocFormatter(ps) {
  const list = [...ps]
    .filter((p) => p.value != null)
    .sort((a, b) => (a.seriesName === 'SOC') - (b.seriesName === 'SOC'))
  if (!list.length) return ''
  return `${list[0].axisValueLabel}<br/>` + list.map((p) => {
    const v = +p.value
    const text = p.seriesName === 'SOC'
      ? `${Math.round(v)}%`
      : `${(p.seriesName.includes('放電') ? Math.abs(v) : v).toFixed(2)} kW`
    return `${p.marker}${p.seriesName}: ${text}`
  }).join('<br/>')
}

/* 住戶看不懂 SOC：住戶畫面把圖上的「SOC」寫成「電量」（圖例、軸名、提示框），管理員照舊。
   系列的名稱在程式裡仍叫 SOC（提示框、線尾標籤靠它判斷單位是 %），只換顯示的字 */
export const socLabel = (admin) => (admin ? 'SOC' : '電量')
export function withSocLabel(o, label) {
  if (label === 'SOC' || !o?.series) return o
  const fmt = o.tooltip?.formatter
  return {
    ...o,
    legend: o.legend && { ...o.legend, formatter: (n) => (n === 'SOC' ? label : n) },
    yAxis: Array.isArray(o.yAxis) ? o.yAxis.map((ax) => (ax?.name === 'SOC' ? { ...ax, name: label } : ax)) : o.yAxis,
    tooltip: typeof fmt === 'function'
      ? { ...o.tooltip, formatter: (...args) => String(fmt(...args) ?? '').replaceAll('SOC', label) }
      : o.tooltip,
  }
}

export function socYAxis({ interval = 50 } = {}) {
  return {
    type: 'value',
    gridIndex: 1,
    name: 'SOC',
    min: 0,
    max: 100,
    interval,
    nameGap: 8,
    nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
    axisLabel: { color: AXIS_TEXT, fontSize: 10, formatter: '{value}%' },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: SPLIT_LINE } },
  }
}

/* ------------------------------------------------------------
   背景電價：每張時間軸的圖都把尖峰／離峰塗上底色，並直接寫出那段的電價（元/度），
   不用把滑鼠移上去才知道。tier、price 是每格的時段與電價（和 x 軸同長）；
   labels 是 x 軸的類別（未來 24 小時那張不是從 00:00 起）。
   功率＋SOC 兩格的圖只在上面那格寫字（label: false 給下面的 SOC 格）。
   ------------------------------------------------------------ */
const TOU_FILL = { peak: 'rgba(239,68,68,0.10)', offpeak: 'rgba(34,197,94,0.07)' }
const TOU_NAME = { peak: '尖峰', offpeak: '離峰' }
export function touMarkArea(tier, price, labels = slotLabels, { label = true } = {}) {
  const areas = []
  let start = 0
  for (let i = 1; i <= tier.length; i++) {
    if (i < tier.length && tier[i] === tier[start]) continue
    // 每段畫到下一段的起點，相鄰兩段之間不留白
    const end = Math.min(i, tier.length - 1)
    const t = tier[start]
    const p = price?.[start]
    areas.push([
      {
        xAxis: labels[start],
        itemStyle: { color: TOU_FILL[t] ?? 'transparent' },
        label: {
          // 太窄（不到 2 小時）的那段放不下字，只塗色
          show: label && i - start >= 8 && Number.isFinite(p),
          formatter: `${TOU_NAME[t] ?? ''} ${Number.isFinite(p) ? p.toFixed(2) : ''} 元`,
          position: 'insideTop',
          color: AXIS_TEXT,
          fontSize: 11,
          fontWeight: 600,
        },
      },
      { xAxis: labels[end] },
    ])
    start = i
  }
  return { silent: true, data: areas }
}

/* 背景電價與時間線（「現在」「明天」那幾條）掛在這條隱形系列上：不在圖例裡（各圖的 legend.data 都列了名單）、
   不畫線、沒有資料所以提示框也不會列出它。原本掛在太陽能或 SOC 那條線上，圖例把那條關掉時背景會跟著不見。
   soc＝掛在功率＋SOC 兩格圖下面那格（SOC 格） */
export const BG_NAME = '__bg'
export function bgSeries({ markArea, markLine, soc = false } = {}) {
  return {
    name: soc ? `${BG_NAME}_soc` : BG_NAME,
    type: 'line',
    data: [],
    silent: true,
    symbol: 'none',
    ...(soc ? { xAxisIndex: 1, yAxisIndex: 1 } : {}),
    ...(markArea ? { markArea } : {}),
    ...(markLine ? { markLine } : {}),
  }
}
