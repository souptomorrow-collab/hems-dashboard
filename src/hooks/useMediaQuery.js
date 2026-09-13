import { useCallback, useSyncExternalStore } from 'react'

/**
 * 訂閱 CSS media query，例如 useMediaQuery('(max-width: 760px)')。
 * 圖表的高度、圖例位置寫在 ECharts option 裡，CSS 管不到，只能在 JS 端依螢幕寬度切換。
 */
export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}
