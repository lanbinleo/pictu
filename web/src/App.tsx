import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Plus,
  Check,
  ImagePlus,
  Info,
  Loader2,
  LogOut,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  Pencil,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Sun,
  UserCircle,
  Wand2,
  X,
} from 'lucide-react'
import { api } from './lib/api'
import { useAppStore } from './store/appStore'
import type { Asset, GenerateResponse, GenerationPlan, Message, Session, SessionDetail, Task, UsageResponse, User } from './types/api'

type Overlay = 'account' | 'admin' | null
type PendingRequest = {
  sessionId: number
  response: GenerateResponse
  message: string
  assetIds: number[]
  settings: { size: string; resolution: string; quality: string; count: number }
}

export function App() {
  const token = useAppStore((s) => s.token)
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  if (!token) {
    return <AuthScreen />
  }
  return <Workspace />
}

function AuthScreen() {
  const setAuth = useAppStore((s) => s.setAuth)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const theme = useAppStore((s) => s.theme)
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
      <button className="icon-button theme-float" onClick={toggleTheme} title="切换明暗模式">
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <section className="auth-copy">
        <div className="brand-mark">
          <Sparkles size={18} />
          <span>PicTu</span>
        </div>
        <h1>PicTu</h1>
        <p>AI 图像会话工作台</p>
      </section>

      <form className="auth-card flat-panel" onSubmit={submit}>
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
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="工作室名称" />
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
          {mode === 'register' ? '创建账户' : '进入'}
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
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const [sessions, setSessions] = useState<Session[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [mobilePanel, setMobilePanel] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [error, setError] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [thinkingText, setThinkingText] = useState('')
  const [streamingSessionId, setStreamingSessionId] = useState<number | null>(null)
  const [optimisticMessages, setOptimisticMessages] = useState<Record<number, Message[]>>({})
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null)
  const [completedNotices, setCompletedNotices] = useState<Record<number, boolean>>({})

  async function refreshSessions() {
    const res = await api.listSessions()
    const items = res.sessions ?? []
    setSessions(items)
    if (!activeSessionId && items[0]) {
      setActiveSessionId(items[0].id)
    }
  }

  async function refreshDetail(id = activeSessionId) {
    if (!id) return
    const next = await api.getSession(id)
    setDetail(next)
  }

  async function refreshWorkspace() {
    await Promise.all([
      refreshDetail().catch(() => undefined),
      refreshSessions().catch(() => undefined),
      api.me().then((res) => setUser(res.user)).catch(() => undefined),
    ])
  }

  async function createSession() {
    const res = await api.createSession('未命名会话')
    setSessions((items) => [res.session, ...items])
    setActiveSessionId(res.session.id)
    setDetail({ session: res.session, assets: [], messages: [], tasks: [] })
    setMobilePanel(false)
  }

  async function renameSession(title: string) {
    if (!activeSessionId) return
    const res = await api.updateSession(activeSessionId, title)
    setDetail((current) => (current ? { ...current, session: res.session } : current))
    setSessions((items) => items.map((item) => (item.id === res.session.id ? res.session : item)))
  }

  useEffect(() => {
    api.me()
      .then((res) => setUser(res.user))
      .catch(() => clearAuth())
    refreshSessions().catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    refreshDetail().catch((err) => setError(err.message))
  }, [activeSessionId])

  useEffect(() => {
    const running = (detail?.tasks ?? []).some((task) => task.status === 'pending' || task.status === 'processing')
    if (!running || !activeSessionId) return
    const timer = window.setInterval(() => {
      refreshDetail().catch(() => undefined)
      api.me().then((res) => setUser(res.user)).catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [detail?.tasks, activeSessionId])

  useEffect(() => {
    const hasRunningSession = sessions.some((session) => session.task_status === 'pending' || session.task_status === 'processing')
    if (!hasRunningSession) return
    const timer = window.setInterval(() => {
      refreshSessions().catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [sessions])

  const tasks = detail?.tasks ?? []
  const assets = detail?.assets ?? []
  const messages = detail?.messages ?? []
  const visibleStreamingText = streamingSessionId === activeSessionId ? streamingText : ''
  const visibleThinkingText = streamingSessionId === activeSessionId ? thinkingText : ''
  const visibleOptimisticMessages = activeSessionId ? optimisticMessages[activeSessionId] ?? [] : []

  return (
    <main className="app-shell">
      <aside className={`session-panel ${mobilePanel ? 'open' : ''}`}>
        <div className="panel-head">
          <div className="brand-mark compact">
            <Sparkles size={16} />
            <span>PicTu</span>
          </div>
          <button className="icon-button" onClick={createSession} title="新建会话">
            <MessageSquarePlus size={18} />
          </button>
        </div>

        <nav className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={session.id === activeSessionId ? 'active' : ''}
              onClick={() => {
                setActiveSessionId(session.id)
                if (session.task_status === 'completed') {
                  setCompletedNotices((items) => ({ ...items, [session.id]: false }))
                }
                setMobilePanel(false)
              }}
              title={session.title}
            >
              <SessionDot session={session} hasRequest={pendingRequest?.sessionId === session.id} completedNotice={completedNotices[session.id]} />
              {session.title}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="user-chip" onClick={() => setOverlay('account')} title="用户中心">
            <UserCircle size={18} />
            <span>{user?.display_name || user?.email}</span>
            <strong>{user?.credits ?? 0}</strong>
          </button>
          <div className="foot-actions">
            {user?.role === 'admin' && (
              <button className="icon-button" onClick={() => setOverlay('admin')} title="管理员面板">
                <Shield size={18} />
              </button>
            )}
            <button className="icon-button" onClick={toggleTheme} title="切换明暗模式">
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="icon-button" onClick={clearAuth} title="退出登录">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setMobilePanel(true)} title="会话列表">
            <PanelLeft size={18} />
          </button>
          <EditableTitle title={detail?.session.title ?? '未命名会话'} onSave={renameSession} />
          <button className="icon-button" title="参数与参考图在右侧面板，移动端位于底部">
            <Info size={18} />
          </button>
        </header>
        {error && <p className="inline-error">{error}</p>}
        <MessageStream messages={[...messages, ...visibleOptimisticMessages]} tasks={tasks} streamingText={visibleStreamingText} thinkingText={visibleThinkingText} />
        <Composer
          sessionId={activeSessionId}
          assets={assets}
          onChanged={async () => {
            await refreshWorkspace()
            if (activeSessionId) {
              setOptimisticMessages((items) => ({ ...items, [activeSessionId]: [] }))
            }
          }}
          setStreamingText={setStreamingText}
          setThinkingText={setThinkingText}
          setStreamingSessionId={setStreamingSessionId}
          setOptimisticMessages={setOptimisticMessages}
          pendingRequest={pendingRequest?.sessionId === activeSessionId ? pendingRequest : null}
          setPendingRequest={setPendingRequest}
        />
      </section>

      <aside className="asset-panel">
        <AssetRack sessionId={activeSessionId} assets={assets} onChanged={() => refreshDetail()} />
        <GenerationSettings />
      </aside>

      {overlay === 'account' && <UserCenter onClose={() => setOverlay(null)} />}
      {overlay === 'admin' && user?.role === 'admin' && <AdminPanel onClose={() => setOverlay(null)} />}
    </main>
  )
}

function SessionDot({ session, hasRequest, completedNotice }: { session: Session; hasRequest: boolean; completedNotice?: boolean }) {
  let cls = ''
  if (hasRequest) cls = 'request'
  else if (session.task_status === 'pending' || session.task_status === 'processing') cls = 'working'
  else if (session.task_status === 'completed' && completedNotice !== false) cls = 'done'
  if (!cls) return <span className="session-dot empty" />
  return <span className={`session-dot ${cls}`} />
}

function EditableTitle({ title, onSave }: { title: string; onSave: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)

  useEffect(() => setValue(title), [title])

  async function save() {
    const trimmed = value.trim()
    if (trimmed && trimmed !== title) {
      await onSave(trimmed)
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="title-editor">
        <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus />
        <button className="icon-button" onClick={save} title="保存名称">
          <Check size={17} />
        </button>
        <button className="icon-button" onClick={() => setEditing(false)} title="取消">
          <X size={17} />
        </button>
      </div>
    )
  }

  return (
    <div className="title-line">
      <h1>{title}</h1>
      <button className="icon-button quiet" onClick={() => setEditing(true)} title="修改会话名称">
        <Pencil size={16} />
      </button>
    </div>
  )
}

function MessageStream({
  messages,
  tasks,
  streamingText,
  thinkingText,
}: {
  messages: Message[]
  tasks: Task[]
  streamingText: string
  thinkingText: string
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, tasks.length, streamingText, thinkingText])

  const latestTask = tasks[0]
  const resultImages = useMemo(() => extractImages(latestTask), [latestTask?.result_json])

  return (
    <div className="message-stream">
      {messages.length === 0 && (
        <div className="empty-state">
          <Sparkles size={24} />
          <h2>开始一张图</h2>
        </div>
      )}
      {messages.map((msg) => (
        <article className={`message ${msg.role}`} key={msg.id}>
          <MarkdownText text={msg.content} />
          {msg.prompt && (
            <details>
              <summary>Prompt</summary>
              <pre>{msg.prompt}</pre>
            </details>
          )}
        </article>
      ))}
      {latestTask && (
        <article className="task-card">
          {latestTask.status !== 'completed' && (
            <>
              <div className="task-meta">
                <span>{latestTask.status}</span>
                <strong>{latestTask.progress}%</strong>
              </div>
              <div className="progress">
                <span style={{ width: `${Math.max(latestTask.progress, 8)}%` }} />
              </div>
            </>
          )}
          {latestTask.error && <p className="form-error">{latestTask.error}</p>}
          {resultImages.length > 0 && (
            <div className="result-grid">
              {resultImages.map((url) => (
                <button key={url} onClick={() => setPreview(url)} title="预览图片">
                  <img src={url} alt="Generated result" />
                </button>
              ))}
            </div>
          )}
        </article>
      )}
      {(thinkingText || streamingText) && (
        <article className="message assistant streaming-message">
          {thinkingText && (
            <details>
              <summary>Thinking</summary>
              <pre>{thinkingText}</pre>
            </details>
          )}
          {streamingText && <MarkdownText text={streamingText} />}
        </article>
      )}
      <div ref={bottomRef} />
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function Composer({
  sessionId,
  assets,
  onChanged,
  setStreamingText,
  setThinkingText,
  setStreamingSessionId,
  setOptimisticMessages,
  pendingRequest,
  setPendingRequest,
}: {
  sessionId: number | null
  assets: Asset[]
  onChanged: () => void | Promise<void>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setThinkingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingSessionId: React.Dispatch<React.SetStateAction<number | null>>
  setOptimisticMessages: React.Dispatch<React.SetStateAction<Record<number, Message[]>>>
  pendingRequest: PendingRequest | null
  setPendingRequest: React.Dispatch<React.SetStateAction<PendingRequest | null>>
}) {
  const draft = useAppStore((s) => s.draft)
  const setDraft = useAppStore((s) => s.setDraft)
  const selectedAssetIds = useAppStore((s) => s.selectedAssetIds)
  const toggleAsset = useAppStore((s) => s.toggleAsset)
  const clearSelectedAssets = useAppStore((s) => s.clearSelectedAssets)
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const setUploadProvider = useAppStore((s) => s.setUploadProvider)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [modalSettings, setModalSettings] = useState(settings)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const selectedAssets = assets.filter((asset) => selectedAssetIds.includes(asset.id))

  async function requestGenerate(
    targetSessionId: number,
    message: string,
    assetIds: number[],
    baseSettings: typeof settings,
    extra?: Partial<typeof settings> & { confirmed?: boolean; prompt?: string; assistant_message?: string },
  ) {
    if (!message.trim()) return
    setBusy(true)
    setError('')
    try {
      const res = await api.generate(targetSessionId, {
        message,
        asset_ids: assetIds,
        ...baseSettings,
        ...extra,
      })
      if (res.requires_confirmation) {
        setPendingRequest({ sessionId: targetSessionId, response: res, message, assetIds, settings: baseSettings })
        setModalSettings({
          size: res.plan.size,
          resolution: res.plan.resolution,
          quality: res.plan.quality,
          count: res.plan.count,
        })
        return
      }
      if (res.generated || res.message) {
        setDraft('')
        clearSelectedAssets()
      }
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!sessionId || !draft.trim()) return
    const submitted = draft.trim()
    const submittedAssetIds = [...selectedAssetIds]
    const submittedSettings = { ...settings }
    const submittedAssets = assets.filter((asset) => submittedAssetIds.includes(asset.id))
    const now = new Date().toISOString()
    setOptimisticMessages((items) => ({
      ...items,
      [sessionId]: [
        {
          id: -Date.now(),
          session_id: sessionId,
          role: 'user',
          content: withReferenceMarkdown(submitted, submittedAssets),
          created_at: now,
        },
      ],
    }))
    setDraft('')
    clearSelectedAssets()
    setBusy(true)
    setError('')
    setStreamingSessionId(sessionId)
    setStreamingText('')
    setThinkingText('')
    let keepStream = false
    let completed = false
    try {
      await api.generateStream(
        sessionId,
        {
          message: submitted,
          asset_ids: submittedAssetIds,
          ...submittedSettings,
        },
        (event) => {
          if (event.type === 'content') {
            setStreamingText((text) => text + event.text)
          } else if (event.type === 'thinking') {
            setThinkingText((text) => text + event.text)
          } else if (event.type === 'confirm') {
            keepStream = true
            setPendingRequest({ sessionId, response: event, message: submitted, assetIds: submittedAssetIds, settings: submittedSettings })
            setModalSettings({
              size: event.plan.size,
              resolution: event.plan.resolution,
              quality: event.plan.quality,
              count: event.plan.count,
            })
          } else if (event.type === 'done') {
            completed = true
          } else if (event.type === 'error') {
            setError(event.error)
          }
        },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
      if (completed) {
        await onChanged()
      }
      if (!keepStream) {
        setStreamingText('')
        setThinkingText('')
        setStreamingSessionId(null)
      }
    }
  }

  async function confirmWith(nextSettings: typeof settings, persist: boolean) {
    if (!pendingRequest) return
    if (persist) {
      setSettings(nextSettings)
    }
    await requestGenerate(pendingRequest.sessionId, pendingRequest.message, pendingRequest.assetIds, pendingRequest.settings, {
      ...nextSettings,
      confirmed: true,
      prompt: pendingRequest.response.plan.prompt,
      assistant_message: pendingRequest.response.plan.assistant_message,
    })
    setPendingRequest(null)
  }

  async function uploadFiles(files: FileList | File[] | null) {
    if (!sessionId || !files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          const res = await api.uploadAsset(sessionId, file, uploadProvider)
          toggleAsset(res.asset.id)
        }
      }
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <form className="composer" onSubmit={submit}>
        {selectedAssets.length > 0 && (
          <div className="selected-strip">
            {selectedAssets.map((asset, index) => (
              <span key={asset.id} title={asset.file_name}>
                <img src={asset.url} alt={asset.file_name} />
                图{index + 1}
              </span>
            ))}
          </div>
        )}
        <div className="composer-box">
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} title="上传参考图">
            {uploading ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
          </button>
          <input
            ref={fileInputRef}
            className="hidden-file"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              uploadFiles(event.target.files)
              event.currentTarget.value = ''
            }}
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
              if (files.length > 0) {
                event.preventDefault()
                uploadFiles(files)
              }
            }}
            placeholder="描述你想要的画面或修改。"
            rows={3}
          />
          <button className="send-button" disabled={busy || !sessionId} title="发送给 Planner">
            {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
      <div className="upload-provider">
        <span>上传到</span>
        <select value={uploadProvider} onChange={(event) => setUploadProvider(event.target.value)}>
          <option value="evolink">Evolink</option>
          <option value="maxqi">MaxQi</option>
        </select>
      </div>
      {pendingRequest?.response.requires_confirmation && (
        <PlanConfirmDialog
          plan={pendingRequest.response.plan}
          settings={settings}
          modalSettings={modalSettings}
          setModalSettings={setModalSettings}
          onUseCurrent={() => confirmWith(settings, false)}
          onUseCustom={() => confirmWith(modalSettings, true)}
          onContinue={() => setPendingRequest(null)}
          onCancel={() => {
            setPendingRequest(null)
            setOptimisticMessages((items) => (sessionId ? { ...items, [sessionId]: [] } : items))
            setStreamingText('')
            setThinkingText('')
            setStreamingSessionId(null)
            setError('已取消本次生图')
          }}
        />
      )}
    </>
  )
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function withReferenceMarkdown(text: string, assets: Asset[]) {
  if (assets.length === 0) return text
  const refs = assets.map((asset, index) => `![图${index + 1}](${asset.url})`).join(' ')
  return `${text}\n\n${refs}`
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-frame" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <img src={src} alt="Preview" />
      </div>
    </div>
  )
}

function PlanConfirmDialog({
  plan,
  settings,
  modalSettings,
  setModalSettings,
  onUseCurrent,
  onUseCustom,
  onContinue,
  onCancel,
}: {
  plan: GenerationPlan
  settings: { size: string; resolution: string; quality: string; count: number }
  modalSettings: { size: string; resolution: string; quality: string; count: number }
  setModalSettings: (settings: { size: string; resolution: string; quality: string; count: number }) => void
  onUseCurrent: () => void
  onUseCustom: () => void
  onContinue: () => void
  onCancel: () => void
}) {
  return (
    <div className="overlay">
      <section className="overlay-panel confirm-panel">
        <header>
          <h2>Planner 建议修改参数</h2>
          <button className="icon-button" onClick={onContinue} title="继续讨论">
            <X size={18} />
          </button>
        </header>
        <div className="overlay-body">
          <div className="compare-grid">
            <Metric label="当前比例" valueText={settings.size} />
            <Metric label="建议比例" valueText={plan.size} />
            <Metric label="当前清晰度" valueText={settings.resolution} />
            <Metric label="建议清晰度" valueText={plan.resolution} />
            <Metric label="当前质量" valueText={settings.quality} />
            <Metric label="建议质量" valueText={plan.quality} />
            <Metric label="当前数量" valueText={String(settings.count)} />
            <Metric label="建议数量" valueText={String(plan.count)} />
          </div>
          <section className="panel-block">
            <h3>直接修改后生成</h3>
            <div className="settings-inline">
              <select value={modalSettings.size} onChange={(e) => setModalSettings({ ...modalSettings, size: e.target.value })}>
                {['auto', '1:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <select value={modalSettings.resolution} onChange={(e) => setModalSettings({ ...modalSettings, resolution: e.target.value })}>
                {['1K', '2K', '4K'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <select value={modalSettings.quality} onChange={(e) => setModalSettings({ ...modalSettings, quality: e.target.value })}>
                {['low', 'medium', 'high'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={4}
                value={modalSettings.count}
                onChange={(e) => setModalSettings({ ...modalSettings, count: Number(e.target.value) })}
              />
            </div>
          </section>
          <details>
            <summary>Prompt</summary>
            <pre>{plan.prompt}</pre>
          </details>
          <div className="confirm-actions">
            <button className="secondary-button" onClick={onCancel}>
              取消生图
            </button>
            <button className="secondary-button" onClick={onContinue}>
              继续讨论
            </button>
            <button className="secondary-button" onClick={onUseCurrent}>
              保持当前并生成
            </button>
            <button className="primary-button" onClick={onUseCustom}>
              修改并生成
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function AssetRack({ sessionId, assets, onChanged }: { sessionId: number | null; assets: Asset[]; onChanged: () => void }) {
  const selectedAssetIds = useAppStore((s) => s.selectedAssetIds)
  const toggleAsset = useAppStore((s) => s.toggleAsset)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function upload(files: FileList | null) {
    if (!sessionId || !files?.length) return
    setBusy(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        await api.uploadAsset(sessionId, file, uploadProvider)
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
        <label className="icon-button file-button" title="上传参考图">
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
            title={asset.file_name}
          >
            <img src={asset.url} alt={asset.file_name} />
          </button>
        ))}
      </div>
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
        <Settings2 size={17} />
      </div>
      <label title="比例为 auto 时，resolution 不参与尺寸推导。">
        比例
        <select value={settings.size} onChange={(e) => setSettings({ size: e.target.value })}>
          {['auto', '1:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9'].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label title="1K/2K/4K 只在比例尺寸下生效。">
        清晰度
        <select value={settings.resolution} onChange={(e) => setSettings({ resolution: e.target.value })}>
          {['1K', '2K', '4K'].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label title="high 约为 medium 的 4 倍成本，low 约为 0.25 倍。">
        质量
        <select value={settings.quality} onChange={(e) => setSettings({ quality: e.target.value })}>
          {['low', 'medium', 'high'].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label title="每张输出都会独立计费。">
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

function UserCenter({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    api.usage().then(setData).catch((err) => setError(err.message))
  }, [])

  return (
    <Overlay title="用户中心" onClose={onClose}>
      {error && <p className="form-error">{error}</p>}
      {data ? (
        <>
          <div className="metric-grid">
            <Metric label="Credits" value={data.summary.credits} />
            <Metric label="生成" value={data.summary.generated_tasks} />
            <Metric label="已完成" value={data.summary.completed_tasks} />
            <Metric label="参考图" value={data.summary.reference_images} />
          </div>
          <section className="panel-block">
            <h3>账单</h3>
            <div className="ledger-list">
              {(data.ledger ?? []).map((item) => (
                <div key={item.id}>
                  <span>{item.reason}</span>
                  <strong className={item.delta > 0 ? 'positive' : 'negative'}>{item.delta > 0 ? `+${item.delta}` : item.delta}</strong>
                  <small>{new Date(item.created_at).toLocaleString()}</small>
                </div>
              ))}
            </div>
          </section>
          <section className="panel-block">
            <h3>参考图</h3>
            <div className="asset-grid library">
              {(data.assets ?? []).map((asset) => (
                <button key={asset.id} onClick={() => setPreview(asset.url)} title={asset.file_name}>
                  <img src={asset.url} alt={asset.file_name} />
                </button>
              ))}
            </div>
          </section>
        </>
      ) : (
        <Loader2 className="spin" size={20} />
      )}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
    </Overlay>
  )
}

function AdminPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [delta, setDelta] = useState<Record<number, string>>({})
  const [error, setError] = useState('')

  async function load() {
    const res = await api.adminUsers()
    setUsers(res.users ?? [])
  }

  async function adjust(user: User) {
    const value = Number(delta[user.id])
    if (!Number.isFinite(value) || value === 0) return
    try {
      const res = await api.adminAdjustCredits(user.id, { delta: value, reason: 'admin_adjustment' })
      setUsers((items) => items.map((item) => (item.id === user.id ? res.user : item)))
      setDelta((current) => ({ ...current, [user.id]: '' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '调整失败')
    }
  }

  useEffect(() => {
    load().catch((err) => setError(err.message))
  }, [])

  return (
    <Overlay title="管理员" onClose={onClose}>
      {error && <p className="form-error">{error}</p>}
      <div className="admin-list">
        {users.map((item) => (
          <div className="admin-row" key={item.id}>
            <div>
              <strong>{item.display_name}</strong>
              <span>{item.email}</span>
            </div>
            <code>{item.role}</code>
            <b>{item.credits}</b>
            <input value={delta[item.id] ?? ''} onChange={(e) => setDelta((current) => ({ ...current, [item.id]: e.target.value }))} placeholder="+10 / -5" />
            <button className="secondary-button" onClick={() => adjust(item)}>
              调整
            </button>
          </div>
        ))}
      </div>
    </Overlay>
  )
}

function Overlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="overlay">
      <section className="overlay-panel">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="overlay-body">{children}</div>
      </section>
    </div>
  )
}

function Metric({ label, value, valueText }: { label: string; value?: number; valueText?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{valueText ?? value}</strong>
    </div>
  )
}

function extractImages(task?: Task): string[] {
  if (!task?.result_json) return []
  try {
    const parsed = JSON.parse(task.result_json)
    const urls = new Set<string>()
    const walk = (value: unknown) => {
      if (typeof value === 'string' && /^(https?:\/\/.+|\/generated\/.+)\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) {
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
