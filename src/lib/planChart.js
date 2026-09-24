/* 功率＋SOC 圖（主頁面的即時運轉、今日全天、未來 24 小時，用電規劃的未來 24 小時）共用的 option 產生器。
   功率在上、SOC 在下面一小格（見 charts.js 的 powerSocLayout）；背景照每格的時段塗色並寫出電價。 */
import { COLORS, BATTERY, slotToTime } from './constants.js'
import {
  valueYAxis,
  baseTooltip,
  baseLegend,
  touMarkArea,
  bgSeries,
  BG_NAME,
  slotLabels,
  powerSocLayout,
  powerSocFormatter,
  socYAxis,
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK_LINE,
} from './charts.js'

export const PLAN_SOC_H = 140 // 計畫那幾張的 SOC 小圖高度（SOC 在 15%～90% 之間變化，太矮會看起來是一條平線）

/** 時間線標籤的對齊：清晨往右長、深夜往左長，才不會壓到左上角的軸名「kW」或超出右邊界 */
export function edgeAlign(s) {
  return s < 24 ? 'left' : s > 72 ? 'right' : 'center'
}

/** 一張圖裡所有功率值（放電畫成負的），決定 kW 軸用 */
export const allKw = (d) => [
  ...d.pv, ...d.load, ...d.gridKw, ...d.chargeKw, ...d.dischargeKw.map((v) => -v),
].filter((v) => Number.isFinite(v))

/** 刻度間距挑「不超過 maxTicks 格」的最小值，上下限對齊到間距上；
    直接拿資料的最大最小值當上下限，軸上會出現 8、6、3、0、-3、-5 這種不等距的刻度 */
export function niceAxis(lo, hi, maxTicks = 7) {
  const step = [0.5, 1, 2, 5, 10].find((st) => (Math.ceil(hi / st) - Math.floor(lo / st)) <= maxTicks) ?? 10
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, interval: step }
}

/**
 * d：pv、load、gridKw、chargeKw、dischargeKw、socPct、tier、price（每格一個值；labels 不給就是 00:00 起的 96 格）。
 * playhead：在第幾格畫「現在」那條線（null＝不畫）；detail：較高的 SOC 小圖、不平滑、較寬的長條（計畫那幾張）。
 */
export function powerSocOption(d, { playhead = null, playheadLabel = null, kwAxis, detail = false, animation = true, labels = null } = {}) {
  const smooth = !detail
  const x = labels ?? slotLabels
  return {
    animation,
    tooltip: { ...baseTooltip, formatter: powerSocFormatter },
    color: [COLORS.solar, COLORS.load, COLORS.grid, 'rgba(34,197,94,0.55)', 'rgba(249,115,22,0.6)', COLORS.battery],
    legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
    ...powerSocLayout(detail ? { socH: PLAN_SOC_H } : {}),
    yAxis: [valueYAxis('kW', kwAxis), socYAxis(detail ? { interval: 25 } : {})],
    series: [
      {
        name: '太陽能發電',
        type: 'line',
        smooth,
        symbol: 'none',
        data: d.pv,
        lineStyle: { width: 2, color: COLORS.solar },
        areaStyle: { color: 'rgba(255,176,32,0.18)' },
      },
      { name: '家庭負載', type: 'line', smooth, symbol: 'none', data: d.load, lineStyle: { width: 2, color: COLORS.load } },
      {
        name: '電網購電', type: 'line', smooth, symbol: 'none', data: d.gridKw,
        lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' },
      },
      {
        name: '電池充電', type: 'bar', stack: 'batt', ...(detail ? { barCategoryGap: '8%' } : {}),
        data: d.chargeKw, itemStyle: { color: 'rgba(34,197,94,0.55)' },
      },
      {
        name: '電池放電', type: 'bar', stack: 'batt', ...(detail ? { barCategoryGap: '8%' } : {}),
        data: d.dischargeKw.map((v) => (v == null ? null : -v)), itemStyle: { color: 'rgba(249,115,22,0.6)' },
      },
      {
        name: 'SOC',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        smooth,
        symbol: 'none',
        data: d.socPct,
        lineStyle: { width: 2.5, color: COLORS.battery },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
          lineStyle: { color: TRACK_LINE, type: 'dashed' },
          data: [{ yAxis: Math.round(BATTERY.socMax * 100) }, { yAxis: Math.round(BATTERY.socMin * 100) }],
        },
      },
      // 背景電價與「現在」那條線：掛在隱形系列上，圖例關掉太陽能或 SOC 也還在
      bgSeries({
        markArea: touMarkArea(d.tier, d.price, x),
        markLine: playhead == null
          ? undefined
          : {
              silent: true,
              symbol: 'none',
              label: {
                formatter: playheadLabel ?? slotToTime(playhead),
                rotate: 0,
                position: 'end',
                distance: 4,
                align: edgeAlign(playhead),
                color: TEXT_MAIN,
                fontSize: 11,
                fontWeight: 700,
                backgroundColor: 'rgba(20,184,166,0.16)',
                borderColor: COLORS.save,
                borderWidth: 1,
                borderRadius: 4,
                padding: [3, 6],
              },
              lineStyle: { color: COLORS.save, width: 1.5, type: 'solid' },
              data: [{ xAxis: playhead }],
            },
      }),
      bgSeries({ markArea: touMarkArea(d.tier, d.price, x, { label: false }), soc: true }),
    ],
  }
}

/** x 軸換成自訂的 96 格標籤（跨日的加「明天 」「昨天 」），軸上只寫時刻、每兩小時一個 */
function customAxis(o, labels) {
  const even = (_i, v) => /(^|\s)([01]\d|2[0-3]):00$/.test(v) && +v.slice(-5, -3) % 2 === 0
  o.xAxis = o.xAxis.map((ax) => ({
    ...ax,
    data: labels,
    axisLabel: { ...ax.axisLabel, interval: even, formatter: (v) => v.replace(/^(明天|昨天) /, '') },
  }))
}

const tag = (text, align, extra = {}) => ({
  formatter: text, rotate: 0, position: 'end', distance: 4, align,
  color: TEXT_MAIN, fontSize: 11, fontWeight: 700, ...extra,
})

/** 未來 24 小時（fetchRolling 的結果）：最左邊是現在，明天 00:00 畫一條虛線 */
export function rollingOption(r) {
  const vals = allKw(r)
  const o = powerSocOption(r, { kwAxis: niceAxis(Math.min(0, ...vals), Math.max(0, ...vals), 10), detail: true, labels: r.labels })
  customAxis(o, r.labels)
  // 「現在」固定在最左邊，kW 軸名改成靠軸線左側，兩個標籤才不會疊在一起
  o.yAxis = o.yAxis.map((ax, i) => (i ? ax : { ...ax, nameTextStyle: { ...ax.nameTextStyle, align: 'right' } }))
  const lines = [{
    xAxis: 0,
    label: tag(`現在 ${slotToTime(r.startSlot)}`, 'left', {
      backgroundColor: 'rgba(20,184,166,0.16)', borderColor: COLORS.save, borderWidth: 1, borderRadius: 4, padding: [3, 6],
    }),
    lineStyle: { color: COLORS.save, width: 1.5, type: 'solid' },
  }]
  if (r.midnight != null) {
    // 午夜離「現在」太近（深夜）時只畫線、不寫字，免得壓在「現在」的標籤上
    lines.push({
      xAxis: r.midnight,
      label: r.midnight < 12 ? { show: false }
        : tag('明天', r.midnight > 84 ? 'right' : 'left', { color: AXIS_TEXT, fontWeight: 600, padding: [0, 0, 0, 4] }),
      lineStyle: { color: AXIS_TEXT, width: 1, type: 'dashed' },
    })
  }
  o.series = o.series.map((s) => (s.name === BG_NAME ? { ...s, markLine: { silent: true, symbol: 'none', data: lines } } : s))
  return o
}

/** 過去 24 小時（fetchPast24 的結果）：最右邊是現在，今天 00:00 畫一條虛線；kwAxis 由呼叫端給（播放時才不會跳） */
export function past24Option(r, { kwAxis, animation = true } = {}) {
  const o = powerSocOption(r, { kwAxis, animation, labels: r.labels })
  customAxis(o, r.labels)
  const lines = [{
    xAxis: r.labels.length - 1,
    label: tag(`現在 ${slotToTime(r.endSlot)}`, 'right', {
      backgroundColor: 'rgba(20,184,166,0.16)', borderColor: COLORS.save, borderWidth: 1, borderRadius: 4, padding: [3, 6],
    }),
    lineStyle: { color: COLORS.save, width: 1.5, type: 'solid' },
  }]
  if (r.midnight != null) {
    lines.push({
      xAxis: r.midnight,
      label: r.midnight > 84 ? { show: false } : tag('今天', r.midnight < 12 ? 'left' : 'center', { color: AXIS_TEXT, fontWeight: 600 }),
      lineStyle: { color: AXIS_TEXT, width: 1, type: 'dashed' },
    })
  }
  o.series = o.series.map((s) => (s.name === BG_NAME ? { ...s, markLine: { silent: true, symbol: 'none', data: lines } } : s))
  return o
}
