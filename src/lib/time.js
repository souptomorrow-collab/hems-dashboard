/* ============================================================
   情境地點與時區：台北 Taipei（Asia/Taipei, UTC+8, 無日光節約）

   不論使用者的瀏覽器在哪個時區，UI 都以「台北時間」呈現，
   這樣時鐘、日／夜、尖離峰電價時段都會以台北為準。
   ============================================================ */
export const LOCATION = {
  city: '台北',
  en: 'Taipei',
  tz: 'Asia/Taipei',
  lat: 25.03,
  lng: 121.56,
  label: '台北 Taipei',
  utc: 'UTC+8',
}

/**
 * 取得目前的「台北時間」。
 * 回傳的 Date 物件，其本地 getter（getHours/getDate/getMonth/getDay）
 * 會直接是台北的牆上時間。台灣固定 UTC+8、無日光節約，所以 +8 永遠正確。
 */
export function nowTaipei() {
  const n = new Date()
  return new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 8 * 3600000)
}
