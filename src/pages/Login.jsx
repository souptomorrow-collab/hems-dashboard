import { useEffect, useState } from 'react'
import { login } from '../lib/auth.js'
import { useTheme, toggleTheme } from '../lib/theme.js'

/**
 * 登入頁。
 * 帳號由管理者提供，分「住戶」「管理員」兩種角色，登入後看到的畫面不同（見 lib/auth.js）。
 * 這是前端檢查，只用來區分畫面，不是資安保護。
 */
export default function Login() {
  const theme = useTheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = '登入｜家庭能源管理系統'
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError('請輸入帳號和密碼')
      return
    }
    setBusy(true)
    setError('')
    const res = await login(username.trim(), password, remember)
    setBusy(false)
    if (!res.ok) {
      setError(res.message)
      setPassword('')
    }
  }

  return (
    <div className="login-page">
      <button
        className="theme-toggle login-theme"
        onClick={toggleTheme}
        title={theme === 'dark' ? '切換為日間模式' : '切換為夜間模式'}
        aria-label={theme === 'dark' ? '切換為日間模式' : '切換為夜間模式'}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <div className="logo" aria-hidden="true">⚡</div>
          <div>
            <strong>HEMS</strong>
            <span>家庭能源管理系統</span>
          </div>
        </div>

        <div>
          <h1>登入</h1>
          <p className="login-sub">基於發電量與負載預測之家庭能源管理系統</p>
        </div>

        <label className="login-field" htmlFor="login-username">
          <span>帳號</span>
          <input
            id="login-username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="login-field" htmlFor="login-password">
          <span>密碼</span>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label className="login-remember" htmlFor="login-remember">
          <input
            id="login-remember"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          在這台裝置保持登入 30 天
        </label>

        {error && <p className="login-error" role="alert">{error}</p>}

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? '登入中…' : '登入'}
        </button>

        <p className="login-note">帳號由系統管理者提供</p>
      </form>
    </div>
  )
}
