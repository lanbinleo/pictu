import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ImagePlus,
  Loader2,
  LogOut,
  MessageSquarePlus,
  PanelLeft,
  Send,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { api } from './lib/api'
import { useAppStore } from './store/appStore'
import type { Asset, Message, Session, SessionDetail, Task } from './types/api'

export function App() {
  const token = useAppStore((s) => s.token)
  if (!token) {
    return <AuthScreen />
  }
  return <Workspace />
}

function AuthScreen() {
  const setAuth = useAppStore((s) => s.setAuth)
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
      const res =
        mode === 'register'
          ? await api.register({ email, password, display_name: displayName })
          : await api.login({ email, password })
      setAuth(res.token, res.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-copy">
        <div className="brand-mark">
          <Sparkles size={18} />
          <span>PicTu</span>
        </div>
        <h1>一间安静的 AI 图像工作室</h1>
        <p>上传参考图，用自然语言描述目标，后端会优化 prompt、计费并托管生成任务。</p>
      </section>

      <form className="auth-card" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            注册
          </button>
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            登录
          </button>
        </div>
        {mode === 'register' && (
          <label>
            名称
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="你的工作室名" />
          </label>
        )}
        <label>
          邮箱
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="you@example.com" />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            minLength={8}
            placeholder="至少 8 位"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <Wand2 size={17} />}
          {mode === 'register' ? '创建账户' : '进入工作台'}
        </button>
      </form>
    </main>
  )
}

function Workspace() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId)
  const clearAuth = useAppStore((s) => s.clearAuth)
  const user = useAppStore((s) => s.user)
  const setUser = useAppStore((s) => s.setUser)
  const [sessions, setSessions] = useState<Session[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [mobilePanel, setMobilePanel] = useState(false)
  const [error, setError] = useState('')

  async function refreshSessions() {
    const res = await api.listSessions()
    const items = res.sessions ?? []
    setSessions(items)
    if (!activeSessionId && items[0]) {
      setActiveSessionId(items[0].id)
    }
  }

  async function createSession() {
    const res = await api.createSession('新的图像会话')
    setSessions((items) => [res.session, ...items])
    setActiveSessionId(res.session.id)
    setMobilePanel(false)
  }

  useEffect(() => {
    api.me()
      .then((res) => setUser(res.user))
      .catch(() => clearAuth())
    refreshSessions().catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    if (!activeSessionId) {
      setDetail(null)
      return
    }
    api.getSession(activeSessionId).then(setDetail).catch((err) => setError(err.message))
  }, [activeSessionId])

  useEffect(() => {
    const running = (detail?.tasks ?? []).some((task) => task.status === 'pending' || task.status === 'processing')
    if (!running || !activeSessionId) {
      return
    }
    const timer = window.setInterval(() => {
      api.getSession(activeSessionId).then(setDetail).catch(() => undefined)
      api.me().then((res) => setUser(res.user)).catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [detail?.tasks, activeSessionId])

  const tasks = detail?.tasks ?? []
  const assets = detail?.assets ?? []
  const messages = detail?.messages ?? []

  return (
    <main className="app-shell">
      <aside className={`session-panel ${mobilePanel ? 'open' : ''}`}>
        <div className="panel-head">
          <div className="brand-mark compact">
            <Sparkles size={16} />
            <span>PicTu</span>
          </div>
          <button className="icon-button" onClick={createSession} title="新会话">
            <MessageSquarePlus size={18} />
          </button>
        </div>
        <div className="credit-card">
          <span>Credits</span>
          <strong>{user?.credits ?? 0}</strong>
        </div>
        <nav className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={session.id === activeSessionId ? 'active' : ''}
              onClick={() => {
                setActiveSessionId(session.id)
                setMobilePanel(false)
              }}
            >
              {session.title}
            </button>
          ))}
        </nav>
        <button className="ghost-button" onClick={clearAuth}>
          <LogOut size={16} />
          退出
        </button>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setMobilePanel(true)} title="会话">
            <PanelLeft size={18} />
          </button>
          <div>
            <span className="eyebrow">AI image workspace</span>
            <h1>{detail?.session.title ?? '新的图像会话'}</h1>
          </div>
        </header>
        {error && <p className="inline-error">{error}</p>}
        <MessageStream messages={messages} tasks={tasks} />
        <Composer
          sessionId={activeSessionId}
          assets={assets}
          onChanged={() => activeSessionId && api.getSession(activeSessionId).then(setDetail)}
        />
      </section>

      <aside className="asset-panel">
        <AssetRack sessionId={activeSessionId} assets={assets} onChanged={() => activeSessionId && api.getSession(activeSessionId).then(setDetail)} />
        <GenerationSettings />
      </aside>
    </main>
  )
}

function MessageStream({ messages, tasks }: { messages: Message[]; tasks: Task[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, tasks.length])

  const latestTask = tasks[0]
  const resultImages = useMemo(() => extractImages(latestTask), [latestTask?.result_json])

  return (
    <div className="message-stream">
      {messages.length === 0 && (
        <div className="empty-state">
          <Sparkles size={24} />
          <h2>先上传参考图，或直接描述你想生成的画面。</h2>
          <p>模型看不到图片内容，但会按你给出的“图一、图二”关系组织 prompt，并把 prompt 展示给你。</p>
        </div>
      )}
      {messages.map((msg) => (
        <article className={`message ${msg.role}`} key={msg.id}>
          <p>{msg.content}</p>
          {msg.prompt && (
            <details open>
              <summary>Prompt</summary>
              <pre>{msg.prompt}</pre>
            </details>
          )}
        </article>
      ))}
      {latestTask && (
        <article className="task-card">
          <div className="task-meta">
            <span>{latestTask.status}</span>
            <strong>{latestTask.progress}%</strong>
          </div>
          <div className="progress">
            <span style={{ width: `${Math.max(latestTask.progress, latestTask.status === 'completed' ? 100 : 8)}%` }} />
          </div>
          {latestTask.error && <p className="form-error">{latestTask.error}</p>}
          {resultImages.length > 0 && (
            <div className="result-grid">
              {resultImages.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt="Generated result" />
                </a>
              ))}
            </div>
          )}
        </article>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function Composer({ sessionId, assets, onChanged }: { sessionId: number | null; assets: Asset[]; onChanged: () => void }) {
  const draft = useAppStore((s) => s.draft)
  const setDraft = useAppStore((s) => s.setDraft)
  const selectedAssetIds = useAppStore((s) => s.selectedAssetIds)
  const clearSelectedAssets = useAppStore((s) => s.clearSelectedAssets)
  const settings = useAppStore((s) => s.settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selectedAssets = assets.filter((asset) => selectedAssetIds.includes(asset.id))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!sessionId || !draft.trim()) return
    setBusy(true)
    setError('')
    try {
      await api.generate(sessionId, {
        message: draft,
        asset_ids: selectedAssetIds,
        ...settings,
      })
      setDraft('')
      clearSelectedAssets()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      {selectedAssets.length > 0 && (
        <div className="selected-strip">
          {selectedAssets.map((asset, index) => (
            <span key={asset.id}>图{index + 1}: {asset.file_name}</span>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="例如：参考图一的人物姿态，把图二改成温暖胶片质感，保持背景简洁。"
          rows={3}
        />
        <button className="send-button" disabled={busy || !sessionId}>
          {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </form>
  )
}

function AssetRack({ sessionId, assets, onChanged }: { sessionId: number | null; assets: Asset[]; onChanged: () => void }) {
  const selectedAssetIds = useAppStore((s) => s.selectedAssetIds)
  const toggleAsset = useAppStore((s) => s.toggleAsset)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function upload(files: FileList | null) {
    if (!sessionId || !files?.length) return
    setBusy(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        await api.uploadAsset(sessionId, file)
      }
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="tool-section">
      <div className="section-title">
        <h2>参考图</h2>
        <label className="icon-button file-button" title="上传图片">
          {busy ? <Loader2 className="spin" size={18} /> : <ImagePlus size={18} />}
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => upload(e.target.files)} />
        </label>
      </div>
      <div className="asset-grid">
        {assets.map((asset) => (
          <button
            key={asset.id}
            className={selectedAssetIds.includes(asset.id) ? 'selected' : ''}
            onClick={() => toggleAsset(asset.id)}
          >
            <img src={asset.url} alt={asset.file_name} />
            <span>{asset.file_name}</span>
          </button>
        ))}
      </div>
      {assets.length === 0 && <p className="muted">支持 jpg、png、webp，单张不超过 50MB。</p>}
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

function GenerationSettings() {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  return (
    <section className="tool-section">
      <div className="section-title">
        <h2>参数</h2>
      </div>
      <label>
        比例
        <select value={settings.size} onChange={(e) => setSettings({ size: e.target.value })}>
          {['auto', '1:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9'].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        清晰度
        <select value={settings.resolution} onChange={(e) => setSettings({ resolution: e.target.value })}>
          {['1K', '2K', '4K'].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        质量
        <select value={settings.quality} onChange={(e) => setSettings({ quality: e.target.value })}>
          {['low', 'medium', 'high'].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        数量
        <input
          type="number"
          min={1}
          max={4}
          value={settings.count}
          onChange={(e) => setSettings({ count: Number(e.target.value) })}
        />
      </label>
    </section>
  )
}

function extractImages(task?: Task): string[] {
  if (!task?.result_json) return []
  try {
    const parsed = JSON.parse(task.result_json)
    const urls = new Set<string>()
    const walk = (value: unknown) => {
      if (typeof value === 'string' && /^https?:\/\/.+\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) {
        urls.add(value)
      } else if (Array.isArray(value)) {
        value.forEach(walk)
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk)
      }
    }
    walk(parsed)
    return Array.from(urls)
  } catch {
    return []
  }
}
