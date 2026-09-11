import { useEffect, useMemo, useRef, useState } from 'react'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import EChart from '../components/EChart.jsx'
import EnergyFlow from '../components/EnergyFlow.jsx'
import { fetchLive, fetchToday, fetchRollingForecast } from '../api/client.js'
import { COLORS, BATTERY } from '../lib/constants.js'
import { useTheme } from '../lib/theme.js'
import { useDemoClock, slotToDate } from '../lib/demoClock.js'
import { useClock, useCurrentSlot } from '../hooks/useClock.js'
import { slotToTime } from '../lib/constants.js'
import {
  slotXAxis,
  valueYAxis,
  baseTooltip,
  baseLegend,
  baseGrid,
  peakMarkArea,
  AXIS_TEXT,
  TEXT_MAIN,
  TRACK,
  TRACK_LINE,
} from '../lib/charts.js'

export default function Dashboard() {
  const theme = useTheme() // 主題一換，下面的圖表 option 就會重算
  const demo = useDemoClock()
  const now = useClock() // 展示模式開著時，這個已經是虛擬時間
  const curSlot = useCurrentSlot() // 過去／未來的分界，也決定滾動預測取哪一筆

  // kW 軸的範圍「只增不減」。
  // 滾動預測每前進一格就換一次資料，若讓軸自動縮放，播放時整張圖會不停上下跳，
  // 前後時刻也沒辦法比較。記住看過的最大／最小值，軸就只會變寬不會變窄。
  const kwRange = useRef({ min: 0, max: 0 })
  const [live, setLive] = useState(null)
  const [today, setToday] = useState(null)
  const [roll, setRoll] = useState(null) // 滾動預測的原始矩陣（給滾動預測那張圖）

  // 即時快照。
  // 真實時間：每 5 秒抓一次。
  // 展示模式：改由「目前播到第幾格」驅動，每前進一格就重算一次，
  //          這樣畫面更新的節奏和進度條、時鐘完全同步。
  useEffect(() => {
    let on = true
    const at = demo.enabled ? slotToDate(demo.slot) : undefined
    const tick = () => fetchLive(at, curSlot).then((d) => on && setLive(d))
    tick()
    if (demo.enabled) return () => { on = false }
    const id = setInterval(tick, 5000)
    return () => {
      on = false
      clearInterval(id)
    }
  }, [demo.enabled, demo.slot, curSlot])

  // 今日整日：每前進一格就重算一次。
  // RF 是滾動預測（每 15 分鐘重發未來 96 步），所以「未來」那段會隨時間更新；
  // 「過去」那段吃的是真實值、不會變，dispatch 又是照時間順序推的，
  // 因此已經發生的電池／電網軌跡自然凍住，不需要另外處理。
  useEffect(() => {
    fetchToday(now, curSlot).then(setToday)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSlot, demo.enabled])

  // 滾動預測的原始矩陣：載入一次就好，之後只是依目前格數取不同的列
  useEffect(() => {
    fetchRollingForecast().then(setRoll)
  }, [])

  // ---- 主圖：今日功率總覽 ----
  /* ------------------------------------------------------------
     即時 vs 預測：拆成兩張圖

     原本只有一張「今日功率總覽」畫滿全天 96 格，但在任一時刻，
     只有「到現在為止」那段是已經發生的，後面都還是預測，混在同一張圖裡
     會讓人分不清哪些是結果、哪些是計畫。

     這裡用同一個 option 產生器做兩張：
       upTo 有值  → 只畫到第 upTo 格（之後補 null），曲線隨時間長出來
       upTo 為 null → 整天都畫，並在展示模式下標出目前播到哪

     x 軸兩張都保持完整的 24 小時，即時那張才不會邊播邊縮放。

     註：目前「即時」那段是把同一條模擬曲線切到現在為止。之後接上真實
     量測後，這裡應改讀量測紀錄，而不是切預測曲線。
     ------------------------------------------------------------ */
  const dayOption = (upTo, showPlayhead) => {
    // 只保留 upTo 之前的點，之後補 null（ECharts 會直接斷線，不會連到 0）
    const clip = (arr) =>
      upTo == null ? arr : arr.map((v, i) => (i <= upTo ? v : null))
    if (!today) return {}

    // kW 軸的範圍一律用「整天」的資料算，兩張圖才會是同一把尺；
    // 否則即時那張會隨著資料長出來一直自動縮放，也沒辦法和下面那張對照。
    const all = [
      ...today.pv, ...today.load, ...today.gridKw,
      ...today.chargeKw, ...today.dischargeKw.map((v) => -v),
    ].filter((v) => Number.isFinite(v))
    kwRange.current = {
      max: Math.max(kwRange.current.max, Math.ceil(Math.max(0, ...all))),
      min: Math.min(kwRange.current.min, Math.floor(Math.min(0, ...all))),
    }
    const { min: kwMin, max: kwMax } = kwRange.current
    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .map((p) => {
              const val =
                p.seriesName === 'SOC'
                  ? `${Math.round(p.value)}%`
                  : `${(+p.value).toFixed(2)} kW`
              return `${p.marker}${p.seriesName}: ${val}`
            })
            .join('<br/>'),
      },
      color: [COLORS.solar, COLORS.load, COLORS.grid, 'rgba(34,197,94,0.55)', 'rgba(249,115,22,0.6)', COLORS.battery],
      legend: { ...baseLegend, data: ['太陽能發電', '家庭負載', '電網購電', '電池充電', '電池放電', 'SOC'] },
      grid: { ...baseGrid, right: 48 },
      xAxis: slotXAxis(),
      yAxis: [
        valueYAxis('kW', { min: kwMin, max: kwMax }),
        {
          type: 'value',
          name: 'SOC %',
          min: 0,
          max: 100,
          position: 'right',
          nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
          axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: '{value}%' },
          axisLine: { show: false },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '太陽能發電',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: clip(today.pv),
          lineStyle: { width: 2, color: COLORS.solar },
          areaStyle: { color: 'rgba(255,176,32,0.18)' },
          markArea: peakMarkArea(today.tier),
          // 展示模式下標出「現在播到哪」，一天 96 格的進度一眼可見
          markLine: showPlayhead && demo.enabled
            ? {
                silent: true,
                symbol: 'none',
                label: {
                  formatter: slotToTime(demo.slot),
                  // 垂直的 markLine 標籤預設會跟著線轉成直排，要明確轉回水平
                  rotate: 0,
                  position: 'end',
                  distance: 4,
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
                data: [{ xAxis: demo.slot }],
              }
            : undefined,
        },
        {
          name: '家庭負載',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: clip(today.load),
          lineStyle: { width: 2, color: COLORS.load },
        },
        {
          name: '電網購電',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: clip(today.gridKw),
          lineStyle: { width: 1.5, color: COLORS.grid, type: 'dashed' },
        },
        {
          name: '電池充電',
          type: 'bar',
          stack: 'batt',
          data: clip(today.chargeKw),
          itemStyle: { color: 'rgba(34,197,94,0.55)' },
        },
        {
          name: '電池放電',
          type: 'bar',
          stack: 'batt',
          data: clip(today.dischargeKw).map((v) => (v == null ? null : -v)),
          itemStyle: { color: 'rgba(249,115,22,0.6)' },
        },
        {
          name: 'SOC',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'none',
          data: clip(today.socPct),
          lineStyle: { width: 2.5, color: COLORS.battery },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { color: AXIS_TEXT, fontSize: 10, formatter: '{c}%' },
            lineStyle: { color: TRACK_LINE, type: 'dashed' },
            data: [{ yAxis: 90 }, { yAxis: 10 }],
          },
        },
      ],
    }
  }

  const realtimeOption = useMemo(
    () => dayOption(curSlot, false),
    [today, theme, curSlot]
  )
  const dayPlanOption = useMemo(
    () => dayOption(null, true),
    [today, theme, demo.enabled, demo.slot]
  )

  /* ------------------------------------------------------------
     滾動預測：把「不同時間點發布的預測」並排畫出來

     為什麼需要獨立一張：滾動在「今日預測與排程」那張圖上幾乎看不出來。
     實測相鄰兩次刷新對同一時刻平均只差 0.015 kW，而那張圖的軸被
     00:00 的預充尖刺撐到 9 kW 高，差異只佔軸高約 0.2%，大概一個像素。
     這張只畫不可轉移負載、用它自己的尺度，滾動才看得見。

       紫色實線  現在這一格發布的最新預測
       淡色虛線  1～4 小時前發布的預測（越舊越淡）
       實線      當天真實值（只畫到現在，未來還不知道）
     ------------------------------------------------------------ */
  // y 軸用整份資料算一次、之後固定，播放時才不會跳
  const rollRange = useMemo(() => {
    if (!roll) return { min: 0, max: 1, interval: 0.2 }
    const vals = [...roll.actual, ...roll.rolling.flat()].filter((v) => Number.isFinite(v))
    const peak = Math.max(...vals)
    // 刻度間距和最大值要一起決定，否則最大值不在刻度上，
    // 頂端會出現 1.5、1.6 兩個標籤疊在一起
    const interval = peak > 1.2 ? 0.4 : 0.2
    return { min: 0, max: Math.ceil(peak / interval) * interval, interval }
  }, [roll])

  const rollingOption = useMemo(() => {
    if (!roll) return {}
    const s = curSlot
    // 第 iss 格發布的那次預測，攤回一日 96 格；發布之前的時段沒有值
    const issued = (iss) => {
      const row = roll.rolling[iss]
      return Array.from({ length: 96 }, (_, i) =>
        row && i > iss ? (row[i - iss - 1] ?? null) : null
      )
    }
    const earlier = [16, 12, 8, 4].map((k) => s - k).filter((x) => x >= 0)
    const actual = roll.actual.map((v, i) => (i <= s ? v : null))
    const base = { type: 'line', smooth: true, symbol: 'none', connectNulls: false }

    // tooltip 要標出每條虛線是幾點發布的，但圖例不能每格都換名字（會一直閃），
    // 所以圖例統一叫「較早的預測」，發布時間另外記在這裡給 tooltip 用
    const issueOf = [...earlier, s, null]

    return {
      tooltip: {
        ...baseTooltip,
        formatter: (ps) =>
          `${ps[0].axisValueLabel}<br/>` +
          ps
            .filter((p) => p.value != null)
            .map((p) => {
              const iss = issueOf[p.seriesIndex]
              const who =
                iss == null ? '真實值' : iss === s ? `${slotToTime(iss)} 發布（最新）` : `${slotToTime(iss)} 發布`
              return `${p.marker}${who}: ${(+p.value).toFixed(3)} kW`
            })
            .join('<br/>'),
      },
      legend: { ...baseLegend, data: ['真實值', '最新預測', '較早的預測'] },
      grid: { ...baseGrid, right: 24 },
      xAxis: slotXAxis(),
      yAxis: valueYAxis('kW', { min: rollRange.min, max: rollRange.max, interval: rollRange.interval }),
      series: [
        ...earlier.map((iss, j) => ({
          ...base,
          name: '較早的預測',
          data: issued(iss),
          // j 越大越接近現在：越新越清楚
          lineStyle: { width: 1.2, type: 'dashed', color: COLORS.load, opacity: 0.2 + j * 0.15 },
          itemStyle: { color: COLORS.load, opacity: 0.45 },
        })),
        {
          ...base,
          name: '最新預測',
          // 從「現在」這一點接出去：預測本來就是站在目前已知的資料往後推，
          // 不接的話真實值和預測中間會斷一格，看起來像少了資料
          data: issued(s).map((v, i) => (i === s ? (roll.actual[s] ?? v) : v)),
          lineStyle: { width: 2.6, color: COLORS.load },
          itemStyle: { color: COLORS.load },
          markLine: {
            silent: true,
            symbol: 'none',
            label: {
              formatter: `現在 ${slotToTime(s)}`,
              rotate: 0,
              position: 'end',
              distance: 4,
              color: TEXT_MAIN,
              fontSize: 11,
              fontWeight: 700,
            },
            lineStyle: { color: COLORS.save, width: 1.5, type: 'solid' },
            data: [{ xAxis: s }],
          },
        },
        {
          ...base,
          name: '真實值',
          data: actual,
          lineStyle: { width: 2, color: TEXT_MAIN },
          itemStyle: { color: TEXT_MAIN },
        },
      ],
    }
  }, [roll, curSlot, theme, rollRange])


  // ---- 電池 SOC 儀表 ----
  const gaugeOption = useMemo(() => {
    const soc = live?.socPct ?? 0
    return {
      series: [
        {
          type: 'gauge',
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: 100,
          radius: '92%',
          progress: { show: true, width: 14, itemStyle: { color: COLORS.battery } },
          axisLine: { lineStyle: { width: 14, color: [[1, TRACK]] } },
          axisTick: { show: false },
          splitLine: { length: 10, lineStyle: { color: TRACK_LINE } },
          axisLabel: { color: AXIS_TEXT, fontSize: 10, distance: 14 },
          pointer: { width: 4, itemStyle: { color: COLORS.battery } },
          anchor: { show: true, size: 10, itemStyle: { color: COLORS.battery } },
          detail: {
            valueAnimation: true,
            formatter: '{value}%',
            color: TEXT_MAIN,
            fontSize: 26,
            fontWeight: 'bolder',
            offsetCenter: [0, '55%'],
          },
          data: [{ value: soc }],
        },
      ],
    }
  }, [live, theme])

  // ---- 隔日預測：太陽能發電 + 家庭負載 + 淨負載（鴨子曲線）----

  const s = today?.summary

  return (
    <>
      {/* KPI 列 */}
      <div className="grid kpi">
        <StatCard
          icon="☀️"
          color={COLORS.solar}
          label="太陽能即時發電"
          value={live ? live.pvKw.toFixed(2) : '—'}
          unit="kW"
          sub={
            live && live.curtailKw > 0.02
              ? `防逆送削減 ${live.curtailKw.toFixed(2)} kW（可發 ${live.pvPotentialKw.toFixed(2)}）`
              : s
              ? `今日累積發電 ${s.pvKwh} 度`
              : ' '
          }
        />
        <StatCard
          icon="🔋"
          color={COLORS.battery}
          label="電池電量 SOC"
          value={live ? live.socPct.toFixed(0) : '—'}
          unit="%"
          sub={
            live
              ? live.battNetKw > 0.02
                ? `充電中 ${live.chargeKw.toFixed(2)} kW`
                : live.battNetKw < -0.02
                ? `放電中 ${live.dischargeKw.toFixed(2)} kW`
                : `${live.socKwh.toFixed(1)} / ${BATTERY.capacityKwh} 度`
              : ' '
          }
        />
        <StatCard
          icon="🏠"
          color={COLORS.load}
          label="家中總負載"
          value={live ? live.loadKw.toFixed(2) : '—'}
          unit="kW"
          sub={s ? `今日累積用電 ${s.loadKwh} 度` : ' '}
        />
        <StatCard
          icon="🗼"
          color={COLORS.grid}
          label={live && live.gridKw < -0.02 ? '電網逆送' : '電網購電'}
          value={live ? Math.abs(live.gridKw).toFixed(2) : '—'}
          unit="kW"
          sub={live ? `${live.tier === 'peak' ? '尖峰' : '離峰'}・${live.price} 元/度` : ' '}
        />
        <StatCard
          icon="💰"
          color={COLORS.save}
          label="今日省下電費"
          value={s ? s.savings : '—'}
          unit="元"
          sub={s ? `較無儲能節省 ${s.savingPct}%` : ' '}
        />
      </div>

      {/* 流向 + 電池 */}
      <div className="grid cols-2 mt-16">
        <Panel
          title="能源即時流向"
          sub={demo.enabled ? `展示模式・${slotToTime(demo.slot)}` : '每 5 秒更新'}
        >
          <EnergyFlow live={live} />
        </Panel>
        <Panel
          title="電池狀態"
          sub={`Tesla Powerwall 2・${BATTERY.capacityKwh} kWh`}
          style={{ display: 'flex', flexDirection: 'column' }}
          right={
            <span className="badge">
              上下限 {BATTERY.socMin * 100}–{BATTERY.socMax * 100}%
            </span>
          }
        >
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <EChart option={gaugeOption} height={210} style={{ flex: 1 }} />
            <div style={{ flex: 1, display: 'grid', gap: 12 }}>
              <InfoRow label="即時電量" value={`${live ? live.socKwh.toFixed(1) : '—'} 度`} />
              <InfoRow
                label="充電功率"
                value={`${live ? live.chargeKw.toFixed(2) : '—'} kW`}
                color={COLORS.battery}
              />
              <InfoRow
                label="放電功率"
                value={`${live ? live.dischargeKw.toFixed(2) : '—'} kW`}
                color={COLORS.discharge}
              />
              <InfoRow label="最大功率" value={`${BATTERY.maxPowerKw} kW`} />
            </div>
          </div>
        </Panel>
      </div>

      {/* 即時：只畫到目前為止，曲線隨時間長出來 */}
      <Panel
        title="即時運轉"
        sub={`今日 00:00 ～ ${slotToTime(curSlot)}・不可轉移負載取當日真實值（隨時間累積）`}
        className="mt-16"
        right={
          <span className="badge">
            {demo.enabled ? '展示模式' : '真實時間'}・第 {curSlot + 1} / 96 格
          </span>
        }
      >
        <EChart option={realtimeOption} height={300} />
      </Panel>

      {/* 滾動預測：同一段未來在不同時間點被預測成什麼樣子 */}
      {roll && (
        <Panel
          title="不可轉移負載滾動預測"
          sub={`RF 每 15 分鐘重發一次未來 24 小時的預測・紫色實線為 ${slotToTime(curSlot)} 發布的最新一次，淡色虛線為 1～4 小時前發布的`}
          className="mt-16"
          right={<span className="badge">RF 雲端預測・資料集 {roll.targetDate}</span>}
        >
          <EChart option={rollingOption} height={260} />
        </Panel>
      )}

      {/* 預測與排程：整天都畫，和上面那張刻意分開，避免把「已發生」和「還沒發生」混為一談 */}
      <Panel
        title="今日預測與排程"
        sub={`過去用真實值、未來用 ${slotToTime(curSlot)} 發布的最新一次 RF 預測重新規劃・紅底為尖峰時段`}
        className="mt-16"
      >
        <EChart option={dayPlanOption} height={300} />
      </Panel>
    </>
  )
}

function InfoRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      <strong style={{ fontSize: 16, color: color || 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </strong>
    </div>
  )
}
