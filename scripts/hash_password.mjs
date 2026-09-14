/* ============================================================
   產生登入帳號的雜湊：npm run hash-password -- <帳號> <密碼>

   網站沒有後端，帳密只能寫在前端程式裡。這裡把「隨機鹽＋密碼」做 SHA-256，
   src/lib/auth.js 只存鹽和雜湊值，原始碼裡看不到密碼本身。
   注意：這只能擋一般人，懂技術的人看原始碼仍可繞過登入，而且短密碼的雜湊猜得出來，
   不要拿真的在用的密碼來設定。

   印出來的那一行貼到 src/lib/auth.js 的 ACCOUNTS 裡，取代同帳號的舊設定即可。
   ============================================================ */
import { createHash, randomBytes } from 'node:crypto'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('用法：npm run hash-password -- <帳號> <密碼>')
  process.exit(1)
}
const salt = randomBytes(12).toString('hex')
const hash = createHash('sha256').update(salt + password, 'utf8').digest('hex')
console.log(`帳號 ${username} 的設定（貼到 src/lib/auth.js，role 與 label 視需要調整）：`)
console.log(`  { username: '${username}', role: 'resident', label: '住戶', salt: '${salt}', hash: '${hash}' },`)
