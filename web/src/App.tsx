import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive,
  Camera,
  ChevronDown,
  ChevronUp,
  Plus,
  Check,
  CreditCard,
  ImagePlus,
  Images,
  Info,
  KeyRound,
  Languages,
  Lock,
  Loader2,
  LogOut,
  Mail,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  PanelRight,
  Pencil,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Sun,
  RotateCcw,
  Trash2,
  UserRound,
  Wand2,
  X,
} from 'lucide-react'
import { api } from './lib/api'
import { useAppStore } from './store/appStore'
import type { Asset, GenerateResponse, GenerationPlan, Message, Session, SessionDetail, Task, UsageResponse, User } from './types/api'
import { localizeQuality, localizeReason, localizeStatus, translate, type Locale } from './i18n'

type Overlay = 'account' | 'admin' | null
type PendingRequest = {
  sessionId: number
  response: GenerateResponse
  message: string
  assetIds: number[]
  settings: { size: string; resolution: string; quality: string; count: number }
}
type GenerationSettingsValue = PendingRequest['settings']
type ToolDraft = {
  sessionId: number
  phase: 'preparing' | 'calling'
  prompt: string
  raw: string
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
        <h1>艺术灵感从这开始</h1>
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
  const locale = useAppStore((s) => s.locale)
  const setLocale = useAppStore((s) => s.setLocale)
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
  const [toolDraft, setToolDraft] = useState<ToolDraft | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  async function refreshSessions() {
    const res = await api.listSessions()
    const items = res.sessions ?? []
    setSessions((previous) => {
      const previousByID = new Map(previous.map((session) => [session.id, session.task_status]))
      const newNotices: Record<number, boolean> = {}
      for (const item of items) {
        const before = previousByID.get(item.id)
        if ((before === 'pending' || before === 'processing') && item.task_status === 'completed') {
          newNotices[item.id] = true
        }
      }
      if (Object.keys(newNotices).length > 0) {
        setCompletedNotices((current) => ({ ...current, ...newNotices }))
      }
      return items
    })
    if (!activeSessionId && items[0]) {
      setActiveSessionId(items[0].id)
    } else if (activeSessionId && !items.some((item) => item.id === activeSessionId)) {
      setActiveSessionId(items[0]?.id ?? null)
      if (!items[0]) setDetail(null)
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
    const nextSessions = await api.listSessions().then((list) => list.sessions ?? []).catch(() => [res.session])
    setSessions(nextSessions)
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

  async function archiveSession(id: number) {
    await api.archiveSession(id)
    const nextSessions = await api.listSessions().then((res) => res.sessions ?? [])
    setSessions(nextSessions)
    if (id === activeSessionId) {
      const next = nextSessions[0]
      setActiveSessionId(next?.id ?? null)
      setDetail(null)
    }
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

  useEffect(() => {
    if (streamingSessionId !== activeSessionId && (!toolDraft || toolDraft.sessionId !== activeSessionId)) return
    const latest = detail?.tasks?.[0]
    if (latest?.status === 'completed' || latest?.status === 'failed') {
      setStreamingText('')
      setThinkingText('')
      setStreamingSessionId(null)
      setToolDraft(null)
    }
  }, [detail?.tasks, toolDraft, activeSessionId, streamingSessionId])

  const tasks = detail?.tasks ?? []
  const assets = detail?.assets ?? []
  const messages = detail?.messages ?? []
  const visibleStreamingText = streamingSessionId === activeSessionId ? streamingText : ''
  const visibleThinkingText = streamingSessionId === activeSessionId ? thinkingText : ''
  const visibleToolDraft = toolDraft?.sessionId === activeSessionId ? toolDraft : null
  const visibleOptimisticMessages = activeSessionId ? optimisticMessages[activeSessionId] ?? [] : []
  const conversationStarted =
    messages.length > 0 ||
    visibleOptimisticMessages.length > 0 ||
    tasks.length > 0 ||
    Boolean(visibleStreamingText || visibleThinkingText || visibleToolDraft)

  return (
    <main className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      {mobilePanel && <button className="mobile-panel-scrim" aria-label="关闭会话列表" onClick={() => setMobilePanel(false)} />}
      <aside className={`session-panel ${mobilePanel ? 'open' : ''} ${leftCollapsed ? 'collapsed' : ''}`}>
        {leftCollapsed ? (
          <div className="collapsed-rail left-rail">
            <div className="rail-top">
              <button className="rail-button" onClick={() => setLeftCollapsed(false)} title="展开会话栏">
                <PanelLeft size={18} />
              </button>
              <button className="rail-button" onClick={createSession} title="新建会话">
                <MessageSquarePlus size={18} />
              </button>
              <button className="rail-button" onClick={toggleTheme} title="切换明暗模式">
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
            <div className="rail-bottom">
              <button className="rail-button avatar-rail-button" onClick={() => setOverlay('account')} title="设置中心">
                <UserAvatar user={user} size="small" />
              </button>
            </div>
          </div>
        ) : (
          <>
        <div className="panel-head">
          <div className="brand-mark compact">
            <Sparkles size={16} />
            <span>PicTu</span>
          </div>
          <div className="panel-actions">
            <button className="icon-button" onClick={() => setLeftCollapsed(true)} title="折叠会话栏">
              <PanelLeft size={18} />
            </button>
            <button className="icon-button" onClick={createSession} title="新建会话">
              <MessageSquarePlus size={18} />
            </button>
          </div>
        </div>

        <nav className="session-list">
          {sessions.map((session) => (
            <div key={session.id} className={`session-row ${session.id === activeSessionId ? 'active' : ''}`}>
              <button
                className="session-select"
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
                <span className="session-title">{session.title}</span>
              </button>
              <button className="session-archive" title="归档对话" onClick={() => archiveSession(session.id).catch((err) => setError(err.message))}>
                <Archive size={15} />
              </button>
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <UserDock
            user={user}
            open={userMenuOpen}
            theme={theme}
            locale={locale}
            onToggleOpen={() => setUserMenuOpen((open) => !open)}
            onOpenSettings={() => {
              setOverlay('account')
              setUserMenuOpen(false)
            }}
            onOpenAdmin={() => {
              setOverlay('admin')
              setUserMenuOpen(false)
            }}
            onToggleTheme={toggleTheme}
            onToggleLocale={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
            onLogout={clearAuth}
          />
        </div>
          </>
        )}
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
        <MessageStream
          messages={[...messages, ...visibleOptimisticMessages]}
          tasks={tasks}
          streamingText={visibleStreamingText}
          thinkingText={visibleThinkingText}
          toolDraft={visibleToolDraft}
          locale={locale}
        />
        <Composer
          sessionId={activeSessionId}
          assets={assets}
          conversationStarted={conversationStarted}
          onChanged={async () => {
            await refreshWorkspace()
            if (activeSessionId) {
              setOptimisticMessages((items) => ({ ...items, [activeSessionId]: [] }))
            }
          }}
          setStreamingText={setStreamingText}
          setThinkingText={setThinkingText}
          setStreamingSessionId={setStreamingSessionId}
          setToolDraft={setToolDraft}
          setOptimisticMessages={setOptimisticMessages}
          pendingRequest={pendingRequest?.sessionId === activeSessionId ? pendingRequest : null}
          setPendingRequest={setPendingRequest}
        />
      </section>

      <aside className={`asset-panel ${rightCollapsed ? 'collapsed' : ''}`}>
        {rightCollapsed ? (
          <button className="right-edge-toggle" onClick={() => setRightCollapsed(false)} title="展开参数栏">
            <PanelRight size={18} />
          </button>
        ) : (
          <>
            <div className="asset-panel-head">
              <span>工具</span>
              <button className="icon-button" onClick={() => setRightCollapsed(true)} title="折叠参数栏">
                <PanelRight size={18} />
              </button>
            </div>
            <AssetRack sessionId={activeSessionId} assets={assets} onChanged={() => refreshWorkspace()} />
            <GenerationSettings />
          </>
        )}
      </aside>

      {overlay === 'account' && <UserCenter activeSessionId={activeSessionId} onClose={() => setOverlay(null)} onSessionsChanged={refreshWorkspace} />}
      {overlay === 'admin' && user?.role === 'admin' && <AdminPanel onClose={() => setOverlay(null)} />}
    </main>
  )
}

function SessionDot({ session, hasRequest, completedNotice }: { session: Session; hasRequest: boolean; completedNotice?: boolean }) {
  let cls = ''
  if (hasRequest) cls = 'request'
  else if (session.task_status === 'pending' || session.task_status === 'processing') cls = 'working'
  else if (session.task_status === 'completed' && completedNotice === true) cls = 'done'
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
    <div className="title-line" title={title}>
      <h1>{title}</h1>
      <button className="icon-button quiet" onClick={() => setEditing(true)} title="修改会话名称">
        <Pencil size={16} />
      </button>
    </div>
  )
}

function UserAvatar({ user, size = 'regular' }: { user: User | null; size?: 'small' | 'regular' | 'large' }) {
  const name = userDisplayName(user)
  return (
    <span className={`avatar ${size}`}>
      {user?.avatar_url ? <img src={user.avatar_url} alt={name} /> : <span>{initialsFor(name)}</span>}
    </span>
  )
}

function UserDock({
  user,
  open,
  theme,
  locale,
  onToggleOpen,
  onOpenSettings,
  onOpenAdmin,
  onToggleTheme,
  onToggleLocale,
  onLogout,
}: {
  user: User | null
  open: boolean
  theme: 'light' | 'dark'
  locale: Locale
  onToggleOpen: () => void
  onOpenSettings: () => void
  onOpenAdmin: () => void
  onToggleTheme: () => void
  onToggleLocale: () => void
  onLogout: () => void
}) {
  return (
    <div className="user-dock">
      {open && (
        <div className="user-menu">
          <button type="button" onClick={onOpenSettings}>
            <Settings2 size={17} />
            <span>设置中心</span>
          </button>
          <button type="button" onClick={onToggleTheme}>
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === 'dark' ? '切换日间模式' : '切换夜间模式'}</span>
          </button>
          <button type="button" onClick={onToggleLocale}>
            <Languages size={17} />
            <span>{locale === 'zh-CN' ? 'Switch to English' : '切换中文'}</span>
          </button>
          {user?.role === 'admin' && (
            <button type="button" onClick={onOpenAdmin}>
              <Shield size={17} />
              <span>管理员模式</span>
            </button>
          )}
          <button type="button" className="danger-menu-item" onClick={onLogout}>
            <LogOut size={17} />
            <span>退出登录</span>
          </button>
        </div>
      )}
      <button type="button" className="user-dock-trigger" onClick={onToggleOpen} aria-expanded={open} title="账户菜单">
        <UserAvatar user={user} />
        <span>{userDisplayName(user)}</span>
        {open ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
      </button>
    </div>
  )
}

function MessageStream({
  messages,
  tasks,
  streamingText,
  thinkingText,
  toolDraft,
  locale,
}: {
  messages: Message[]
  tasks: Task[]
  streamingText: string
  thinkingText: string
  toolDraft: ToolDraft | null
  locale: Locale
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, tasks.length, streamingText, thinkingText, toolDraft?.prompt, toolDraft?.phase])

  const latestTask = tasks[0]
  const resultImages = useMemo(() => extractImages(latestTask), [latestTask?.result_json])
  const liveTurn = Boolean(thinkingText || streamingText || toolDraft)
  const visibleMessages = useMemo(() => {
    if (!liveTurn) return messages
    return messages.filter((msg) => {
      if (msg.role !== 'assistant') return true
      if (latestTask?.provider_task_id && msg.task_id === latestTask.provider_task_id) return false
      return !(msg.prompt && latestTask)
    })
  }, [messages, liveTurn, latestTask])

  return (
    <div className="message-stream">
      {visibleMessages.length === 0 && !liveTurn && (
        <div className="empty-state">
          <Sparkles size={24} />
          <h2>今天想画点什么？</h2>
        </div>
      )}
      {visibleMessages.map((msg) => {
        const referenceParts = msg.role === 'user' ? splitReferenceMarkdown(msg.content) : { text: msg.content, refs: [] }
        return (
          <article className={`message-turn ${msg.role}`} key={msg.id}>
            <div className={`message ${msg.role}`}>
              <MarkdownText text={referenceParts.text} />
              {msg.prompt && (
                <details>
                  <summary>Prompt</summary>
                  <pre>{msg.prompt}</pre>
                </details>
              )}
            </div>
            {referenceParts.refs.length > 0 && (
              <div className="message-reference-strip">
                {referenceParts.refs.map((ref, index) => (
                  <button key={`${ref.url}-${index}`} type="button" onClick={() => setPreview(ref.url)} title={ref.alt || `参考图 ${index + 1}`}>
                    <img src={ref.url} alt={ref.alt || `Reference ${index + 1}`} />
                  </button>
                ))}
              </div>
            )}
          </article>
        )
      })}
      {(thinkingText || streamingText) && (
        <article className="message assistant streaming-message">
          {thinkingText && (
            <details>
              <summary>思考</summary>
              <pre>{thinkingText}</pre>
            </details>
          )}
          {streamingText && <MarkdownText text={streamingText} />}
        </article>
      )}
      {toolDraft && (
        <article className="task-card tool-draft-card">
          <div className="task-meta">
            <span>{translate(locale, `tool.${toolDraft.phase}`)}</span>
            <Loader2 className="spin" size={16} />
          </div>
          {toolDraft.prompt && (
            <details open>
              <summary>{translate(locale, 'tool.prompt')}</summary>
              <pre>{toolDraft.prompt}</pre>
            </details>
          )}
        </article>
      )}
      {latestTask && (
        <article className="task-card">
          {latestTask.status !== 'completed' && (
            <>
              <div className="task-meta">
                <span>{localizeStatus(locale, latestTask.status)}</span>
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
  setToolDraft,
  setOptimisticMessages,
  pendingRequest,
  setPendingRequest,
  conversationStarted,
}: {
  sessionId: number | null
  assets: Asset[]
  conversationStarted: boolean
  onChanged: () => void | Promise<void>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setThinkingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingSessionId: React.Dispatch<React.SetStateAction<number | null>>
  setToolDraft: React.Dispatch<React.SetStateAction<ToolDraft | null>>
  setOptimisticMessages: React.Dispatch<React.SetStateAction<Record<number, Message[]>>>
  pendingRequest: PendingRequest | null
  setPendingRequest: React.Dispatch<React.SetStateAction<PendingRequest | null>>
}) {
  const draft = useAppStore((s) => s.draft)
  const setDraft = useAppStore((s) => s.setDraft)
  const selectedAssetIds = useAppStore((s) => s.selectedAssetIds)
  const toggleAsset = useAppStore((s) => s.toggleAsset)
  const selectAsset = useAppStore((s) => s.selectAsset)
  const deselectAsset = useAppStore((s) => s.deselectAsset)
  const clearSelectedAssets = useAppStore((s) => s.clearSelectedAssets)
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const setUploadProvider = useAppStore((s) => s.setUploadProvider)
  const usePlanner = useAppStore((s) => s.usePlanner)
  const setUsePlanner = useAppStore((s) => s.setUsePlanner)
  const user = useAppStore((s) => s.user)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [modalSettings, setModalSettings] = useState(settings)
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
  const [assetGalleryOpen, setAssetGalleryOpen] = useState(false)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [galleryPreview, setGalleryPreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const visibleAssets = useMemo(() => uniqueAssets(assets), [assets])
  const galleryAssets = useMemo(() => uniqueAssets([...visibleAssets, ...libraryAssets]), [visibleAssets, libraryAssets])
  const selectedAssets = galleryAssets.filter((asset) => selectedAssetIds.includes(asset.id))
  const composerCentered = !conversationStarted
  const greeting = useMemo(() => buildComposerGreeting(user), [user?.display_name, user?.email])

  function chooseUploadFiles() {
    setAssetGalleryOpen(false)
    setMobileToolsOpen(false)
    window.setTimeout(() => fileInputRef.current?.click(), 0)
  }

  async function loadAssetGallery() {
    setLibraryLoading(true)
    try {
      const res = await api.listAssets()
      setLibraryAssets(res.assets ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '图库加载失败')
    } finally {
      setLibraryLoading(false)
    }
  }

  function openAssetGallery() {
    setAssetGalleryOpen((open) => !open)
    if (!assetGalleryOpen) {
      loadAssetGallery()
    }
  }

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }, [draft])

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
      if (extra?.confirmed && extra.prompt) {
        setStreamingSessionId(targetSessionId)
        setToolDraft({ sessionId: targetSessionId, phase: 'calling', prompt: extra.prompt, raw: '' })
      }
      const res = await api.generate(targetSessionId, {
        message,
        asset_ids: assetIds,
        use_planner: usePlanner,
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
      setToolDraft(null)
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
    setToolDraft(null)
    let keepStream = false
    let completed = false
    let toolUsed = false
    try {
      await api.generateStream(
        sessionId,
        {
          message: submitted,
          asset_ids: submittedAssetIds,
          use_planner: usePlanner,
          ...submittedSettings,
        },
        (event) => {
          if (event.type === 'content') {
            setStreamingText((text) => text + event.text)
          } else if (event.type === 'thinking') {
            setThinkingText((text) => text + event.text)
          } else if (event.type === 'confirm') {
            keepStream = true
            toolUsed = true
            setPendingRequest({ sessionId, response: event, message: submitted, assetIds: submittedAssetIds, settings: submittedSettings })
            setModalSettings({
              size: event.plan.size,
              resolution: event.plan.resolution,
              quality: event.plan.quality,
              count: event.plan.count,
            })
          } else if (event.type === 'done') {
            completed = true
            if (event.plan?.tool_called) {
              toolUsed = true
              setToolDraft((current) =>
                current?.sessionId === sessionId
                  ? { ...current, phase: 'calling', prompt: event.plan.prompt || current.prompt }
                  : { sessionId, phase: 'calling', prompt: event.plan.prompt, raw: '' },
              )
            }
          } else if (event.type === 'error') {
            setError(event.error)
          } else if (event.type === 'tool') {
            toolUsed = true
            setToolDraft((current) => ({
              sessionId,
              phase: event.phase,
              raw: (current?.sessionId === sessionId ? current.raw : '') + (event.text ?? ''),
              prompt: event.prompt ?? current?.prompt ?? '',
            }))
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
        if (!toolUsed) {
          setStreamingText('')
          setThinkingText('')
          setStreamingSessionId(null)
          setToolDraft(null)
        }
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
          selectAsset(res.asset.id)
          setLibraryAssets((items) => uniqueAssets([res.asset, ...items]))
        }
      }
      await Promise.all([onChanged(), loadAssetGallery()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function useGalleryAsset(asset: Asset) {
    if (!sessionId) return
    setError('')
    try {
      if (asset.session_id === sessionId) {
        toggleAsset(asset.id)
        return
      }
      const res = await api.useAsset(sessionId, asset.id)
      selectAsset(res.asset.id)
      setLibraryAssets((items) => uniqueAssets([res.asset, ...items]))
      await Promise.all([onChanged(), loadAssetGallery()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '挂载参考图失败')
    }
  }

  return (
    <>
      <form className={`composer ${composerCentered ? 'centered' : 'docked'}`} onSubmit={submit}>
        {composerCentered && (
          <div className="composer-greeting">
            <span className="greeting-logo">
              <Sparkles size={18} />
            </span>
            <h2>{greeting}</h2>
          </div>
        )}
        {selectedAssets.length > 0 && (
          <div className="selected-strip">
            {selectedAssets.map((asset, index) => (
              <span key={asset.id} title={asset.file_name}>
                <img src={assetImageSrc(asset)} alt={asset.file_name} />
                图{index + 1}
                <button type="button" className="selected-remove" onClick={() => deselectAsset(asset.id)} title="移除参考图">
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-box">
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
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
              if (files.length > 0) {
                event.preventDefault()
                uploadFiles(files)
              }
            }}
            placeholder="今天想画点什么？"
            rows={1}
          />
          <div className="composer-actions">
            <button type="button" className="icon-button" onClick={openAssetGallery} title="参考图库">
              {uploading ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
            </button>
            {assetGalleryOpen && (
              <AssetGalleryPopover
                assets={galleryAssets}
                selectedAssetIds={selectedAssetIds}
                uploadProvider={uploadProvider}
                setUploadProvider={setUploadProvider}
                uploading={uploading}
                loading={libraryLoading}
                onUpload={chooseUploadFiles}
                onUse={useGalleryAsset}
                onPreview={(asset) => setGalleryPreview(assetImageSrc(asset))}
                onClose={() => setAssetGalleryOpen(false)}
              />
            )}
            <label className="planner-switch" title="切换 AI Planner">
              <span>AI Planner</span>
              <input type="checkbox" checked={usePlanner} onChange={(event) => setUsePlanner(event.target.checked)} />
            </label>
            <button type="button" className="icon-button mobile-tools-button" onClick={() => setMobileToolsOpen(true)} title="参数">
              <Settings2 size={18} />
            </button>
            <button className="send-button" disabled={busy || !sessionId} title="发送给 Planner">
              {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
      {mobileToolsOpen && (
        <MobileMoreDrawer
          assets={visibleAssets}
          selectedAssetIds={selectedAssetIds}
          toggleAsset={toggleAsset}
          settings={settings}
          setSettings={setSettings}
          usePlanner={usePlanner}
          setUsePlanner={setUsePlanner}
          onClose={() => setMobileToolsOpen(false)}
          onUpload={() => {
            setMobileToolsOpen(false)
            setAssetGalleryOpen(true)
            loadAssetGallery()
          }}
        />
      )}
      {galleryPreview && <ImageLightbox src={galleryPreview} onClose={() => setGalleryPreview(null)} />}
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
  const refs = assets.map((asset, index) => `![图${index + 1}](${assetImageSrc(asset)})`).join(' ')
  return `${text}\n\n${refs}`
}

function splitReferenceMarkdown(text: string) {
  const refs: { alt: string; url: string }[] = []
  const cleaned = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt: string, url: string) => {
      refs.push({ alt, url })
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: cleaned || text, refs }
}

function ComposerMorePopover({
  usePlanner,
  setUsePlanner,
  onUpload,
}: {
  usePlanner: boolean
  setUsePlanner: (usePlanner: boolean) => void
  onUpload: () => void
}) {
  return (
    <div className="composer-more-popover">
      <label className="switch-row">
        <span>经过 AI Planner</span>
        <input type="checkbox" checked={usePlanner} onChange={(event) => setUsePlanner(event.target.checked)} />
      </label>
      <button type="button" className="secondary-button" onClick={onUpload}>
        <ImagePlus size={16} />
        上传参考图
      </button>
    </div>
  )
}

function MobileMoreDrawer({
  assets,
  selectedAssetIds,
  toggleAsset,
  settings,
  setSettings,
  usePlanner,
  setUsePlanner,
  onClose,
  onUpload,
}: {
  assets: Asset[]
  selectedAssetIds: number[]
  toggleAsset: (id: number) => void
  settings: GenerationSettingsValue
  setSettings: (settings: Partial<GenerationSettingsValue>) => void
  usePlanner: boolean
  setUsePlanner: (usePlanner: boolean) => void
  onClose: () => void
  onUpload: () => void
}) {
  const [page, setPage] = useState(0)
  const touchStartX = useRef<number | null>(null)

  function finishSwipe(x: number) {
    if (touchStartX.current === null) return
    const delta = x - touchStartX.current
    if (Math.abs(delta) > 46) {
      setPage((current) => (delta < 0 ? Math.min(1, current + 1) : Math.max(0, current - 1)))
    }
    touchStartX.current = null
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <section
        className="more-drawer"
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => {
          touchStartX.current = event.touches[0]?.clientX ?? null
        }}
        onTouchEnd={(event) => finishSwipe(event.changedTouches[0]?.clientX ?? 0)}
      >
        <div className="drawer-handle" />
        <header className="drawer-head">
          <h2>更多</h2>
          <div className="drawer-tabs" role="tablist" aria-label="更多页面">
            <button type="button" className={page === 0 ? 'active' : ''} onClick={() => setPage(0)}>
              功能
            </button>
            <button type="button" className={page === 1 ? 'active' : ''} onClick={() => setPage(1)}>
              参数
            </button>
          </div>
        </header>
        <div className="drawer-pages">
          <div className="drawer-track" style={{ transform: `translateX(-${page * 50}%)` }}>
            <div className="drawer-page">
              <label className="switch-row drawer-switch">
                <span>经过 AI Planner</span>
                <input type="checkbox" checked={usePlanner} onChange={(event) => setUsePlanner(event.target.checked)} />
              </label>
              <button type="button" className="drawer-tool" onClick={onUpload}>
                <ImagePlus size={22} />
                <span>上传参考图</span>
              </button>
              {assets.length > 0 && (
                <div className="drawer-assets">
                  {assets.map((asset) => (
                    <button
                      key={asset.id}
                      className={selectedAssetIds.includes(asset.id) ? 'selected' : ''}
                      onClick={() => toggleAsset(asset.id)}
                      title={asset.file_name}
                      type="button"
                    >
                      <img src={assetImageSrc(asset)} alt={asset.file_name} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="drawer-page">
              <SettingsControls settings={settings} setSettings={setSettings} />
            </div>
          </div>
        </div>
        <div className="drawer-dots" aria-hidden="true">
          <span className={page === 0 ? 'active' : ''} />
          <span className={page === 1 ? 'active' : ''} />
        </div>
      </section>
    </div>
  )
}

function SettingsControls({
  settings,
  setSettings,
}: {
  settings: GenerationSettingsValue
  setSettings: (settings: Partial<GenerationSettingsValue>) => void
}) {
  const locale = useAppStore((s) => s.locale)
  return (
    <div className="settings-controls">
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
            <option key={item} value={item}>
              {localizeQuality(locale, item)}
            </option>
          ))}
        </select>
      </label>
      <label title="每张输出都会独立计费。">
        数量
        <input type="number" min={1} max={4} value={settings.count} onChange={(e) => setSettings({ count: Number(e.target.value) })} />
      </label>
    </div>
  )
}

function UploadDestinationDialog({
  uploadProvider,
  setUploadProvider,
  onClose,
  onChoose,
}: {
  uploadProvider: string
  setUploadProvider: (provider: string) => void
  onClose: () => void
  onChoose: () => void
}) {
  return (
    <div className="overlay">
      <section className="overlay-panel upload-dialog">
        <header>
          <h2>上传到哪里</h2>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="overlay-body">
          <label>
            上传位置
            <select value={uploadProvider} onChange={(event) => setUploadProvider(event.target.value)}>
              <option value="evolink">Evolink</option>
              <option value="maxqi">MaxQi</option>
            </select>
          </label>
          <div className="confirm-actions upload-actions">
            <button className="secondary-button" onClick={onClose}>
              取消
            </button>
            <button className="primary-button" onClick={onChoose}>
              选择图片
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function AssetGalleryPopover({
  assets,
  selectedAssetIds,
  uploadProvider,
  setUploadProvider,
  uploading,
  loading,
  onUpload,
  onUse,
  onPreview,
  onClose,
}: {
  assets: Asset[]
  selectedAssetIds: number[]
  uploadProvider: string
  setUploadProvider: (provider: string) => void
  uploading: boolean
  loading: boolean
  onUpload: () => void
  onUse: (asset: Asset) => void | Promise<void>
  onPreview: (asset: Asset) => void
  onClose: () => void
}) {
  return (
    <div className="asset-gallery-popover" onClick={(event) => event.stopPropagation()}>
      <div className="asset-gallery-head">
        <strong>参考图库</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭">
          <X size={16} />
        </button>
      </div>
      <label className="asset-gallery-provider">
        上传到
        <select value={uploadProvider} onChange={(event) => setUploadProvider(event.target.value)}>
          <option value="evolink">Evolink</option>
          <option value="maxqi">MaxQi</option>
        </select>
      </label>
      <div className="asset-gallery-grid">
        <button type="button" className="asset-upload-tile" onClick={onUpload} title="从本地上传参考图">
          {uploading ? <Loader2 className="spin" size={22} /> : <ImagePlus size={22} />}
        </button>
        {assets.map((asset) => (
          <div key={asset.id} className={`asset-tile compact ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`} title={asset.file_name}>
            <img src={assetImageSrc(asset)} alt={asset.file_name} />
            <button className="asset-use" type="button" onClick={() => onUse(asset)} title="使用这张参考图">
              {selectedAssetIds.includes(asset.id) ? '已使用' : '使用'}
            </button>
            <button className="asset-preview-hit" type="button" onClick={() => onPreview(asset)} title="预览图片" />
          </div>
        ))}
        {loading && (
          <div className="asset-gallery-loading">
            <Loader2 className="spin" size={18} />
          </div>
        )}
      </div>
      {!loading && assets.length === 0 && <p className="empty-note">还没有参考图</p>}
    </div>
  )
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
  const locale = useAppStore((s) => s.locale)
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
                  <option key={item} value={item}>
                    {localizeQuality(locale, item)}
                  </option>
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

function AssetRack({ sessionId, assets, onChanged }: { sessionId: number | null; assets: Asset[]; onChanged: () => void | Promise<void> }) {
  const selectedAssetIds = useAppStore((s) => s.selectedAssetIds)
  const toggleAsset = useAppStore((s) => s.toggleAsset)
  const deselectAsset = useAppStore((s) => s.deselectAsset)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const setUploadProvider = useAppStore((s) => s.setUploadProvider)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const visibleAssets = useMemo(() => uniqueAssets(assets), [assets])

  async function upload(files: FileList | null) {
    if (!sessionId || !files?.length) return
    setBusy(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        await api.uploadAsset(sessionId, file, uploadProvider)
      }
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  async function deleteAsset(asset: Asset) {
    setError('')
    try {
      await api.deleteAsset(asset.id)
      deselectAsset(asset.id)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
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
      <label className="upload-destination-inline">
        上传到
        <select value={uploadProvider} onChange={(event) => setUploadProvider(event.target.value)}>
          <option value="evolink">Evolink</option>
          <option value="maxqi">MaxQi</option>
        </select>
      </label>
      <div className="asset-grid">
        {visibleAssets.map((asset) => (
          <div
            key={asset.id}
            className={`asset-tile ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`}
            title={asset.file_name}
          >
            <img src={assetImageSrc(asset)} alt={asset.file_name} />
            <span className="asset-provider-badge">{providerLabel(asset)}</span>
            <button className="asset-use" type="button" onClick={() => toggleAsset(asset.id)} title="使用这张参考图">
              {selectedAssetIds.includes(asset.id) ? '已使用' : '使用'}
            </button>
            <button className="asset-delete" type="button" onClick={() => deleteAsset(asset)} title="移除参考图">
              <X size={14} />
            </button>
          </div>
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
      <SettingsControls settings={settings} setSettings={setSettings} />
    </section>
  )
}

function UserCenter({
  activeSessionId,
  onClose,
  onSessionsChanged,
}: {
  activeSessionId: number | null
  onClose: () => void
  onSessionsChanged: () => void | Promise<void>
}) {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [tab, setTab] = useState<'profile' | 'billing' | 'sessions' | 'gallery'>('profile')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [profileDraft, setProfileDraft] = useState({ display_name: '', email: '' })
  const [passwordDraft, setPasswordDraft] = useState({ current: '', next: '', confirm: '' })
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const user = useAppStore((s) => s.user)
  const setUser = useAppStore((s) => s.setUser)
  const selectAsset = useAppStore((s) => s.selectAsset)
  const deselectAsset = useAppStore((s) => s.deselectAsset)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const setUploadProvider = useAppStore((s) => s.setUploadProvider)
  const locale = useAppStore((s) => s.locale)
  const galleryAssets = useMemo(() => uniqueAssets(data?.assets ?? []), [data?.assets])
  const filteredSessions = useMemo(() => {
    const keyword = sessionQuery.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter((session) => session.title.toLowerCase().includes(keyword))
  }, [sessions, sessionQuery])
  const activeCount = sessions.filter((session) => !session.archived_at).length
  const archivedCount = sessions.length - activeCount

  useEffect(() => {
    if (!user) return
    setProfileDraft({ display_name: user.display_name || '', email: user.email || '' })
  }, [user?.display_name, user?.email])

  async function loadSessions() {
    const res = await api.listAllSessions()
    setSessions(res.sessions ?? [])
  }

  async function updateSessionArchive(session: Session) {
    setError('')
    try {
      if (session.archived_at) {
        await api.unarchiveSession(session.id)
      } else {
        await api.archiveSession(session.id)
      }
      await Promise.all([loadSessions(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function loadUsage() {
    const next = await api.usage()
    setData(next)
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    setProfileSaving(true)
    setError('')
    setNotice('')
    try {
      const res = await api.updateMe(profileDraft)
      setUser(res.user)
      setNotice('资料已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setProfileSaving(false)
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault()
    if (passwordDraft.next !== passwordDraft.confirm) {
      setError('两次输入的新密码不一致')
      return
    }
    setPasswordSaving(true)
    setError('')
    setNotice('')
    try {
      await api.updatePassword({ current_password: passwordDraft.current, new_password: passwordDraft.next })
      setPasswordDraft({ current: '', next: '', confirm: '' })
      setNotice('密码已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改密码失败')
    } finally {
      setPasswordSaving(false)
    }
  }

  async function uploadAvatar(file: File | undefined) {
    if (!file) return
    setAvatarUploading(true)
    setError('')
    setNotice('')
    try {
      const res = await api.uploadAvatar(file)
      setUser(res.user)
      setNotice('头像已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传头像失败')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function useLibraryAsset(asset: Asset) {
    if (!activeSessionId) return
    setError('')
    try {
      const res = await api.useAsset(activeSessionId, asset.id)
      selectAsset(res.asset.id)
      await Promise.all([loadUsage(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function deleteLibraryAsset(asset: Asset) {
    setError('')
    try {
      await api.deleteAsset(asset.id)
      deselectAsset(asset.id)
      await Promise.all([loadUsage(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  async function uploadLibraryAssets(files: FileList | null) {
    if (!activeSessionId || !files?.length) {
      setError('请先选择一个当前对话再上传参考图')
      return
    }
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          const res = await api.uploadAsset(activeSessionId, file, uploadProvider)
          selectAsset(res.asset.id)
        }
      }
      await Promise.all([loadUsage(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function permanentlyDeleteSession(session: Session) {
    if (!window.confirm(`彻底删除「${session.title}」？这个操作不可恢复。`)) return
    setError('')
    try {
      await api.deleteSession(session.id)
      await Promise.all([loadSessions(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  useEffect(() => {
    loadUsage().catch((err) => setError(err.message))
    loadSessions().catch((err) => setError(err.message))
  }, [])

  return (
    <Overlay title="设置中心" onClose={onClose}>
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="form-success">{notice}</p>}
      {data ? (
        <div className="settings-center">
          <aside className="settings-nav">
            <div className="settings-user-card">
              <UserAvatar user={user} size="large" />
              <div>
                <strong>{userDisplayName(user)}</strong>
                <span>{user?.email}</span>
              </div>
            </div>
            <button type="button" className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
              <UserRound size={17} />
              <span>账户</span>
            </button>
            <button type="button" className={tab === 'billing' ? 'active' : ''} onClick={() => setTab('billing')}>
              <CreditCard size={17} />
              <span>账单</span>
            </button>
            <button type="button" className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
              <MessageSquarePlus size={17} />
              <span>对话</span>
            </button>
            <button type="button" className={tab === 'gallery' ? 'active' : ''} onClick={() => setTab('gallery')}>
              <Images size={17} />
              <span>画廊</span>
            </button>
          </aside>
          <div className="settings-content">
            {tab === 'profile' && (
              <div className="settings-page">
                <section className="profile-hero">
                  <button type="button" className="avatar-uploader" onClick={() => avatarInputRef.current?.click()} title="上传头像">
                    <UserAvatar user={user} size="large" />
                    <span>{avatarUploading ? <Loader2 className="spin" size={16} /> : <Camera size={16} />}</span>
                  </button>
                  <input
                    ref={avatarInputRef}
                    className="hidden-file"
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      uploadAvatar(event.target.files?.[0])
                      event.currentTarget.value = ''
                    }}
                  />
                  <div>
                    <h3>{userDisplayName(user)}</h3>
                    <p>{user?.role === 'admin' ? '管理员账户' : '创作账户'}</p>
                  </div>
                </section>
                <form className="profile-form" onSubmit={saveProfile}>
                  <label>
                    <span>
                      <UserRound size={15} />
                      名字
                    </span>
                    <input value={profileDraft.display_name} onChange={(e) => setProfileDraft((draft) => ({ ...draft, display_name: e.target.value }))} />
                  </label>
                  <label>
                    <span>
                      <Mail size={15} />
                      邮箱
                    </span>
                    <input
                      type="email"
                      value={profileDraft.email}
                      onChange={(e) => setProfileDraft((draft) => ({ ...draft, email: e.target.value }))}
                    />
                  </label>
                  <button className="primary-button" disabled={profileSaving}>
                    {profileSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
                    保存资料
                  </button>
                </form>
                <form className="profile-form password-form" onSubmit={savePassword}>
                  <label>
                    <span>
                      <KeyRound size={15} />
                      当前密码
                    </span>
                    <input
                      type="password"
                      value={passwordDraft.current}
                      onChange={(e) => setPasswordDraft((draft) => ({ ...draft, current: e.target.value }))}
                    />
                  </label>
                  <label>
                    <span>
                      <Lock size={15} />
                      新密码
                    </span>
                    <input
                      type="password"
                      minLength={8}
                      value={passwordDraft.next}
                      onChange={(e) => setPasswordDraft((draft) => ({ ...draft, next: e.target.value }))}
                    />
                  </label>
                  <label>
                    <span>
                      <KeyRound size={15} />
                      确认密码
                    </span>
                    <input
                      type="password"
                      minLength={8}
                      value={passwordDraft.confirm}
                      onChange={(e) => setPasswordDraft((draft) => ({ ...draft, confirm: e.target.value }))}
                    />
                  </label>
                  <button className="secondary-button" disabled={passwordSaving}>
                    {passwordSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
                    修改密码
                  </button>
                </form>
              </div>
            )}
            {tab === 'billing' && (
              <div className="settings-page">
                <div className="metric-grid billing-metrics">
                  <Metric label="点数" value={data.summary.credits} />
                  <Metric label="已生成" value={data.summary.generated_tasks} />
                  <Metric label="已完成" value={data.summary.completed_tasks} />
                  <Metric label="已消耗" value={data.summary.credits_spent} />
                </div>
                <section className="panel-block">
                  <h3>账单明细</h3>
                  <div className="ledger-list">
                    {(data.ledger ?? []).map((item) => (
                      <div key={item.id}>
                        <span>{localizeReason(locale, item.reason)}</span>
                        <strong className={item.delta > 0 ? 'positive' : 'negative'}>{item.delta > 0 ? `+${item.delta}` : item.delta}</strong>
                        <small>{new Date(item.created_at).toLocaleString()}</small>
                      </div>
                    ))}
                    {(data.ledger ?? []).length === 0 && <p className="empty-note">还没有账单记录</p>}
                  </div>
                </section>
              </div>
            )}
            {tab === 'sessions' && (
              <div className="settings-page">
                <div className="conversation-toolbar">
                  <div className="conversation-stats">
                    <span>{activeCount} 个活跃</span>
                    <span>{archivedCount} 个归档</span>
                  </div>
                  <input value={sessionQuery} onChange={(e) => setSessionQuery(e.target.value)} placeholder="搜索对话" />
                </div>
                <div className="conversation-list">
                  {filteredSessions.map((session) => (
                    <article key={session.id} className="conversation-item">
                      <div>
                        <strong title={session.title}>{session.title}</strong>
                        <span>{new Date(session.updated_at).toLocaleString()}</span>
                      </div>
                      <code>{session.archived_at ? '已归档' : localizeStatus(locale, session.task_status || '') || '活跃'}</code>
                      <div className="conversation-actions">
                        <button className="icon-button" onClick={() => updateSessionArchive(session)} title={session.archived_at ? '恢复对话' : '归档对话'}>
                          {session.archived_at ? <RotateCcw size={16} /> : <Archive size={16} />}
                        </button>
                        <button className="icon-button danger-button" onClick={() => permanentlyDeleteSession(session)} title="彻底删除">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                  {filteredSessions.length === 0 && <p className="empty-note">没有匹配的对话</p>}
                </div>
              </div>
            )}
            {tab === 'gallery' && (
              <div className="settings-page">
                <div className="gallery-toolbar">
                  <label>
                    上传到
                    <select value={uploadProvider} onChange={(event) => setUploadProvider(event.target.value)}>
                      <option value="evolink">Evolink</option>
                      <option value="maxqi">MaxQi</option>
                    </select>
                  </label>
                  <button type="button" className="primary-button" onClick={() => fileInputRef.current?.click()}>
                    {uploading ? <Loader2 className="spin" size={16} /> : <ImagePlus size={16} />}
                    上传图片
                  </button>
                  <input
                    ref={fileInputRef}
                    className="hidden-file"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      uploadLibraryAssets(event.target.files)
                      event.currentTarget.value = ''
                    }}
                  />
                </div>
                <div className="gallery-grid">
                  {galleryAssets.map((asset) => (
                    <div key={asset.id} className="asset-tile gallery-tile" title={asset.file_name}>
                      <img src={assetImageSrc(asset)} alt={asset.file_name} />
                      <span className="asset-provider-badge">{providerLabel(asset)}</span>
                      <button className="asset-use" type="button" onClick={() => useLibraryAsset(asset)} title="使用这张参考图">
                        使用
                      </button>
                      <button className="asset-delete" type="button" onClick={() => deleteLibraryAsset(asset)} title="移除参考图">
                        <X size={14} />
                      </button>
                      <button className="asset-preview-hit" type="button" onClick={() => setPreview(assetImageSrc(asset))} title="预览图片" />
                    </div>
                  ))}
                </div>
                {galleryAssets.length === 0 && <p className="empty-note">画廊里还没有图片</p>}
              </div>
            )}
          </div>
        </div>
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
  const locale = useAppStore((s) => s.locale)

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
            <code>{translate(locale, `role.${item.role}`, item.role)}</code>
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

function userDisplayName(user: User | null) {
  return user?.display_name?.trim() || user?.email?.split('@')[0] || 'PicTu 用户'
}

function initialsFor(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return 'P'
  const asciiParts = trimmed.split(/\s+/).filter(Boolean)
  if (asciiParts.length > 1) {
    return asciiParts
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase()
}

function buildComposerGreeting(user: User | null) {
  const name = userDisplayName(user)
  const hour = new Date().getHours()
  const dayKey = new Date().toISOString().slice(0, 10)
  const seed = hashString(`${dayKey}:${name}:${Math.floor(hour / 6)}`)
  const playful = [
    `${name}，今天让画面先呼吸一下`,
    `给 ${name} 留一盏灵感的小灯`,
    `${name}，来一张会被记住的图`,
    `今天的第一笔，交给 ${name}`,
  ]
  if (seed % 100 < 9) return playful[seed % playful.length]
  if (hour < 5) return `Night, ${name}`
  if (hour < 12) return `Morning, ${name}`
  if (hour < 18) return `Afternoon, ${name}`
  if (hour < 22) return `Evening, ${name}`
  return `Night, ${name}`
}

function hashString(value: string) {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash
}

function uniqueAssets(assets: Asset[]) {
  const seen = new Set<string>()
  return assets.filter((asset) => {
    const provider = asset.provider || 'default'
    const key = asset.content_hash ? `${provider}:hash:${asset.content_hash}` : asset.url ? `${provider}:url:${asset.url}` : `asset:${asset.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function assetImageSrc(asset: Asset) {
  return asset.local_url || asset.url
}

function providerLabel(asset: Asset) {
  if (!asset.provider) return '未知渠道'
  if (asset.provider === 'evolink') return 'Evolink'
  if (asset.provider === 'maxqi') return 'MaxQi'
  return asset.provider
}

function extractImages(task?: Task): string[] {
  if (!task?.result_json) return []
  try {
    const parsed = JSON.parse(task.result_json)
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { pictu_local_urls?: unknown }).pictu_local_urls)) {
      return ((parsed as { pictu_local_urls: unknown[] }).pictu_local_urls).filter((item): item is string => typeof item === 'string')
    }
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
