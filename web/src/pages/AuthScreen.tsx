import { useState, type FormEvent } from 'react'
import { Loader2, Moon, Sparkles, Sun, Wand2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'

export function AuthScreen() {
  const setAuth = useAppStore((s) => s.setAuth)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const theme = useAppStore((s) => s.theme)
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = mode === 'register'
        ? await api.register({ email, password, display_name: displayName })
        : await api.login({ email, password })
      setAuth(res.token, res.user)
      const next = new URLSearchParams(location.search).get('next') || (location.state as { next?: string } | null)?.next || '/new'
      navigate(next, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <button className="icon-button theme-float" onClick={toggleTheme} title="切换明暗模式">
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <section className="auth-copy">
        <div className="brand-mark">
          <Sparkles size={18} />
          <span>PicTu</span>
        </div>
        <h1>艺术灵感从这开始</h1>
        <p>AI 图像会话工作台</p>
      </section>
      <form className="auth-card" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
        </div>
        {mode === 'register' && (
          <label>名称<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="工作室名称" /></label>
        )}
        <label>邮箱<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="you@example.com" /></label>
        <label>密码<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={8} placeholder="至少 8 位" /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Wand2 size={17} />}
          {mode === 'register' ? '创建账户' : '进入'}
        </button>
      </form>
    </main>
  )
}
