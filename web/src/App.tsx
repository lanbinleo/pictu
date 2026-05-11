import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Archive,
  BarChart3,
  Camera,
  ChevronDown,
  ChevronUp,
  Plus,
  Check,
  CreditCard,
  ImagePlus,
  Images,
  KeyRound,
  Languages,
  Lock,
  Loader2,
  LogOut,
  Mail,
  MessageSquarePlus,
  Minus,
  Move,
  Moon,
  PanelLeft,
  PanelRight,
  Pencil,
  ScrollText,
  Search,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Sun,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api } from './lib/api'
import { useAppStore } from './store/appStore'
import type { AdminStats, Asset, GenerateResponse, GenerationPlan, Message, RuntimeLLMModel, RuntimeSettings, Session, SessionDetail, Task, UsageBucket, UsageResponse, User } from './types/api'
import { localizeQuality, localizeReason, localizeStatus, translate, type Locale } from './i18n'

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
type CanvasNode = {
  id: string
  source: 'asset' | 'task' | 'local'
  asset_id?: number
  task_id?: number
  image_index?: number
  url: string
  title: string
  prompt?: string
  x: number
  y: number
  w: number
  h: number
}
type CanvasState = {
  zoom: number
  panX: number
  panY: number
  nodes: CanvasNode[]
}
type GalleryItem =
  | { id: string; kind: 'asset'; asset: Asset; url: string; title: string; provider: string; created_at: string; generated: boolean }
  | { id: string; kind: 'task'; task: Task; url: string; title: string; provider: string; created_at: string; generated: true }

export function App() {
  const token = useAppStore((s) => s.token)
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <BrowserRouter>
      <AppRoutes token={token} />
    </BrowserRouter>
  )
}

function AppRoutes({ token }: { token: string }) {
  const location = useLocation()
  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<AuthScreen />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ next: `${location.pathname}${location.search}` }} />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/new" replace />} />
      <Route path="/" element={<Navigate to="/new" replace />} />
      <Route path="*" element={<Workspace />} />
    </Routes>
  )
}

// ── Command parsing for Midjourney-style params ──

const COMMAND_PATTERNS: Record<string, RegExp> = {
  size: /--(?:ar|size)\s+([\w:]+)/i,
  resolution: /--(?:res|resolution)\s+(\w+)/i,
  quality: /--(?:q|quality)\s+(\w+)/i,
  count: /--(?:n|count)\s+(\d+)/i,
}

function parseCommands(text: string): { cleanText: string; overrides: Partial<GenerationSettingsValue> } {
  let cleanText = text
  const overrides: Partial<GenerationSettingsValue> = {}
  for (const [key, pattern] of Object.entries(COMMAND_PATTERNS)) {
    const match = cleanText.match(pattern)
    if (match) {
      cleanText = cleanText.replace(match[0], '').trim()
      if (key === 'count') overrides.count = Math.min(4, Math.max(1, Number(match[1])))
      else if (key === 'quality') {
        const q = match[1].toLowerCase()
        if (['low', 'medium', 'high'].includes(q)) overrides.quality = q
        else if (q === 'l') overrides.quality = 'low'
        else if (q === 'm') overrides.quality = 'medium'
        else if (q === 'h') overrides.quality = 'high'
      } else {
        (overrides as Record<string, string>)[key] = match[1]
      }
    }
  }
  return { cleanText, overrides }
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
  const navigate = useNavigate()
  const location = useLocation()
  const [sessions, setSessions] = useState<Session[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [mobilePanel, setMobilePanel] = useState(false)
  const [error, setError] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [thinkingText, setThinkingText] = useState('')
  const [streamingSessionId, setStreamingSessionId] = useState<number | null>(null)
  const [optimisticMessages, setOptimisticMessages] = useState<Record<number, Message[]>>({})
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null)
  const [completedNotices, setCompletedNotices] = useState<Record<number, boolean>>({})
  const [toolDraft, setToolDraft] = useState<ToolDraft | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null)
  const detailRequestId = useRef(0)
  const routePath = location.pathname
  const isNewRoute = routePath === '/new'
  const isChatRoute = routePath.startsWith('/chat/')
  const isCanvasRoute = routePath.startsWith('/canvas/')
  const conversationId = isChatRoute ? routePath.slice('/chat/'.length).split('/')[0] ?? '' : ''
  const canvasId = isCanvasRoute ? routePath.slice('/canvas/'.length).split('/')[0] ?? '' : ''
  const routeSessionId = isChatRoute ? conversationId : isCanvasRoute ? canvasId : ''
  const isWorkspaceRoute = isNewRoute || isChatRoute
  const isSearchRoute = routePath === '/search'
  const isGalleryRoute = routePath === '/gallery'
  const isSettingsRoute = routePath === '/settings'
  const isAdminRoute = routePath === '/admin'
  const isKnownRoute = isWorkspaceRoute || isCanvasRoute || isSearchRoute || isGalleryRoute || isSettingsRoute || isAdminRoute

  async function refreshSessions() {
    const res = await api.listSessions()
    const items = res.sessions ?? []
    setSessions((previous) => {
      const previousByID = new Map(previous.map((s) => [s.id, s.task_status]))
      const newNotices: Record<number, boolean> = {}
      for (const item of items) {
        const before = previousByID.get(item.id)
        if ((before === 'pending' || before === 'processing') && item.task_status === 'completed') {
          newNotices[item.id] = true
        }
      }
      if (Object.keys(newNotices).length > 0) {
        setCompletedNotices((c) => ({ ...c, ...newNotices }))
      }
      return items
    })
    if (isChatRoute || isCanvasRoute) {
      const session = items.find((item) => item.public_id === routeSessionId)
      if (session) {
        setError((current) => (current === '会话不存在' ? '' : current))
        if (activeSessionId !== session.id) setActiveSessionId(session.id)
        if (!detail || detail.session.id !== session.id) {
          await refreshDetail(session.id)
        }
      } else if (items.length > 0) {
        setError('会话不存在')
      }
      return
    }
    if (!isNewRoute && !activeSessionId && items[0]) {
      setActiveSessionId(items[0].id)
    } else if (activeSessionId && !items.some((i) => i.id === activeSessionId)) {
      setActiveSessionId(null)
      setDetail(null)
    }
  }

  async function refreshDetail(id = activeSessionId) {
    if (!id) return
    const requestId = ++detailRequestId.current
    const next = await api.getSession(id)
    if (requestId !== detailRequestId.current) return
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
    const res = await api.createSession('未命名会话', 'chat')
    const nextSessions = await api.listSessions().then((l) => l.sessions ?? []).catch(() => [res.session])
    setSessions(nextSessions)
    setActiveSessionId(res.session.id)
    setDetail({ session: res.session, assets: [], messages: [], tasks: [] })
    setMobilePanel(false)
    navigate(`/chat/${res.session.public_id}`, { replace: true })
    return res.session
  }

  async function createCanvasSession() {
    const res = await api.createSession('新建画布', 'canvas')
    const nextSessions = await api.listSessions().then((l) => l.sessions ?? []).catch(() => [res.session])
    setSessions(nextSessions)
    setActiveSessionId(res.session.id)
    setDetail({ session: res.session, assets: [], messages: [], tasks: [] })
    setMobilePanel(false)
    navigate(`/canvas/${res.session.public_id}`)
    return res.session
  }

  async function renameSession(title: string) {
    if (!activeSessionId) return
    const res = await api.updateSession(activeSessionId, title)
    setDetail((c) => (c ? { ...c, session: res.session } : c))
    setSessions((items) => items.map((i) => (i.id === res.session.id ? res.session : i)))
  }

  async function archiveSession(id: number) {
    await api.archiveSession(id)
    const nextSessions = await api.listSessions().then((r) => r.sessions ?? [])
    setSessions(nextSessions)
    if (id === activeSessionId) {
      const next = nextSessions[0]
      setActiveSessionId(next?.id ?? null)
      setDetail(null)
      navigate(next ? (next.kind === 'canvas' ? `/canvas/${next.public_id}` : `/chat/${next.public_id}`) : '/new', { replace: true })
    }
  }

  useEffect(() => {
    detailRequestId.current += 1
  }, [activeSessionId])

  useEffect(() => {
    api.me().then((res) => setUser(res.user)).catch(() => clearAuth())
    api.runtimeSettings().then((res) => setRuntimeSettings(res.settings)).catch(() => undefined)
    refreshSessions().catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    if ((isChatRoute || isCanvasRoute) && activeSessionId) {
      refreshDetail(activeSessionId).catch((err) => setError(err.message))
      return
    }
    if (isNewRoute) {
      setActiveSessionId(null)
      setDetail(null)
    }
  }, [activeSessionId, routePath, isChatRoute, isCanvasRoute, isNewRoute])

  useEffect(() => {
    if (!isChatRoute && !isCanvasRoute) return
    const session = sessions.find((item) => item.public_id === routeSessionId)
    if (!session) return
    if (activeSessionId !== session.id) setActiveSessionId(session.id)
  }, [routeSessionId, isChatRoute, isCanvasRoute, sessions, activeSessionId])

  useEffect(() => {
    const running = (detail?.tasks ?? []).some((t) => t.status === 'pending' || t.status === 'processing')
    if (!running || !activeSessionId) return
    const timer = window.setInterval(() => {
      refreshDetail().catch(() => undefined)
      api.me().then((res) => setUser(res.user)).catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [detail?.tasks, activeSessionId])

  useEffect(() => {
    const hasRunning = sessions.some((s) => s.task_status === 'pending' || s.task_status === 'processing')
    if (!hasRunning) return
    const timer = window.setInterval(() => { refreshSessions().catch(() => undefined) }, 5000)
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

  useEffect(() => {
    if (isKnownRoute) return
    navigate('/new', { replace: true })
  }, [isKnownRoute, navigate])

  const tasks = detail?.tasks ?? []
  const assets = detail?.assets ?? []
  const messages = detail?.messages ?? []
  const visibleStreamingText = streamingSessionId === activeSessionId ? streamingText : ''
  const visibleThinkingText = streamingSessionId === activeSessionId ? thinkingText : ''
  const visibleToolDraft = toolDraft?.sessionId === activeSessionId ? toolDraft : null
  const visibleOptimisticMessages = activeSessionId ? optimisticMessages[activeSessionId] ?? [] : []
  const conversationStarted = messages.length > 0 || visibleOptimisticMessages.length > 0 || tasks.length > 0 || Boolean(visibleStreamingText || visibleThinkingText || visibleToolDraft)

  function selectSession(id: number) {
    const session = sessions.find((s) => s.id === id)
    if (!session) return
    setActiveSessionId(id)
    if (session.task_status === 'completed') {
      setCompletedNotices((c) => ({ ...c, [id]: false }))
    }
    setMobilePanel(false)
    navigate(session.kind === 'canvas' ? `/canvas/${session.public_id}` : `/chat/${session.public_id}`)
  }

  return (
    <main className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''}`}>
      {mobilePanel && <button className="mobile-panel-scrim" aria-label="关闭" onClick={() => setMobilePanel(false)} />}

      <aside className={`sidebar ${mobilePanel ? 'open' : ''} ${leftCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-brand">
          {!leftCollapsed && <div className="brand-mark"><Sparkles size={16} /><span>PicTu</span></div>}
          <button className="icon-button" onClick={() => setLeftCollapsed(!leftCollapsed)} title={leftCollapsed ? '展开' : '折叠'}>
            <PanelLeft size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <button className="nav-item" onClick={() => navigate('/new')} title="新建对话">
            <MessageSquarePlus size={18} />{!leftCollapsed && <span>新建对话</span>}
          </button>
          <button className="nav-item" onClick={() => createCanvasSession().catch((e) => setError(e.message))} title="新建画布">
            <PanelRight size={18} />{!leftCollapsed && <span>新建画布</span>}
          </button>
          <button className={`nav-item ${isSearchRoute ? 'active' : ''}`} onClick={() => navigate('/search')} title="搜索对话">
            <Search size={18} />{!leftCollapsed && <span>搜索</span>}
          </button>
          <button className={`nav-item ${isGalleryRoute ? 'active' : ''}`} onClick={() => navigate('/gallery')} title="画廊">
            <Images size={18} />{!leftCollapsed && <span>画廊</span>}
          </button>
        </nav>

        {!leftCollapsed && (
          <div className="session-list">
            <div className="session-list-label">最近</div>
            {sessions.map((session) => (
              <div key={session.id} className={`session-row ${session.id === activeSessionId && (isChatRoute || isCanvasRoute) ? 'active' : ''}`}>
                <button className="session-select" onClick={() => selectSession(session.id)} title={session.title}>
                  <SessionDot session={session} hasRequest={pendingRequest?.sessionId === session.id} completedNotice={completedNotices[session.id]} />
                  <span className="session-title">{session.title}</span>
                </button>
                <button className="session-archive" title="归档" onClick={() => archiveSession(session.id).catch((e) => setError(e.message))}>
                  <Archive size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="sidebar-foot">
          <UserDock
            user={user}
            open={userMenuOpen}
            collapsed={leftCollapsed}
            onToggleOpen={() => setUserMenuOpen((o) => !o)}
            onClose={() => setUserMenuOpen(false)}
            onOpenSettings={() => { navigate('/settings'); setUserMenuOpen(false) }}
            onOpenAdmin={() => { navigate('/admin'); setUserMenuOpen(false) }}
            onLogout={() => { clearAuth(); navigate('/login', { replace: true }) }}
          />
        </div>
      </aside>

      {isWorkspaceRoute && (
        <section className="chat-panel">
          <header className="topbar">
            <button className="icon-button mobile-only" onClick={() => setMobilePanel(true)} title="菜单"><PanelLeft size={18} /></button>
            {detail?.session ? <EditableTitle title={detail.session.title} onSave={renameSession} /> : <div className="title-line"><h1>新建对话</h1></div>}
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
              if (activeSessionId) setOptimisticMessages((i) => ({ ...i, [activeSessionId]: [] }))
            }}
            onEnsureSession={createSession}
            setStreamingText={setStreamingText}
            setThinkingText={setThinkingText}
            setStreamingSessionId={setStreamingSessionId}
            setToolDraft={setToolDraft}
            setOptimisticMessages={setOptimisticMessages}
            pendingRequest={pendingRequest?.sessionId === activeSessionId ? pendingRequest : null}
            setPendingRequest={setPendingRequest}
            runtimeSettings={runtimeSettings}
          />
        </section>
      )}

      {isCanvasRoute && activeSessionId && (
        <CanvasPage
          detail={detail}
          sessionId={activeSessionId}
          runtimeSettings={runtimeSettings}
          onChanged={refreshWorkspace}
          onRename={renameSession}
          onOpenMenu={() => setMobilePanel(true)}
        />
      )}
      {isGalleryRoute && <GalleryPage activeSessionId={activeSessionId} onSessionsChanged={refreshWorkspace} runtimeSettings={runtimeSettings} />}
      {isSearchRoute && <ChatsPage sessions={sessions} onSelect={selectSession} onArchive={archiveSession} onRefresh={refreshSessions} />}
      {isSettingsRoute && <SettingsPage />}
      {isAdminRoute && user?.role === 'admin' && <AdminPage />}
    </main>
  )
}

// ── Small components ──

function SessionDot({ session, hasRequest, completedNotice }: { session: Session; hasRequest: boolean; completedNotice?: boolean }) {
  let cls = ''
  if (hasRequest) cls = 'request'
  else if (session.task_status === 'pending' || session.task_status === 'processing') cls = 'working'
  else if (session.task_status === 'completed' && completedNotice === true) cls = 'done'
  if (!cls) return <span className="session-dot empty" />
  return <span className={`session-dot ${cls}`} />
}

function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  useEffect(() => setValue(title), [title])

  async function save() {
    const trimmed = value.trim()
    if (trimmed && trimmed !== title) await onSave(trimmed)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="title-editor">
        <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus />
        <button className="icon-button" onClick={save} title="保存"><Check size={17} /></button>
        <button className="icon-button" onClick={() => setEditing(false)} title="取消"><X size={17} /></button>
      </div>
    )
  }

  return (
    <div className="title-line" title={title}>
      <h1>{title}</h1>
      <button className="icon-button quiet" onClick={() => setEditing(true)} title="修改名称"><Pencil size={16} /></button>
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

function UserDock({ user, open, collapsed, onToggleOpen, onClose, onOpenSettings, onOpenAdmin, onLogout }: {
  user: User | null; open: boolean; collapsed: boolean
  onToggleOpen: () => void; onClose: () => void; onOpenSettings: () => void; onOpenAdmin: () => void; onLogout: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, onClose])

  return (
    <div className="user-dock" ref={ref}>
      {open && (
        <div className="user-menu">
          <button type="button" onClick={onOpenSettings}><Settings2 size={16} /><span>设置</span></button>
          {user?.role === 'admin' && <button type="button" onClick={onOpenAdmin}><Shield size={16} /><span>管理</span></button>}
          <button type="button" className="danger-menu-item" onClick={onLogout}><LogOut size={16} /><span>退出</span></button>
        </div>
      )}
      <button type="button" className="user-dock-trigger" onClick={onToggleOpen} aria-expanded={open} title="账户">
        <UserAvatar user={user} size="small" />
        {!collapsed && <span>{userDisplayName(user)}</span>}
        {!collapsed && (open ? <ChevronDown size={16} /> : <ChevronUp size={16} />)}
      </button>
    </div>
  )
}

// ── MessageStream ──

function MessageStream({ messages, tasks, streamingText, thinkingText, toolDraft, locale }: {
  messages: Message[]; tasks: Task[]; streamingText: string; thinkingText: string; toolDraft: ToolDraft | null; locale: Locale
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
      {visibleMessages.map((msg) => {
        const referenceParts = msg.role === 'user' ? splitReferenceMarkdown(msg.content) : { text: msg.content, refs: [] }
        return (
          <article className={`message-turn ${msg.role}`} key={msg.id}>
            <div className={`message ${msg.role}`}>
              <MarkdownText text={referenceParts.text} />
              {msg.prompt && <details><summary>Prompt</summary><pre>{msg.prompt}</pre></details>}
            </div>
            {referenceParts.refs.length > 0 && (
              <div className="message-reference-strip">
                {referenceParts.refs.map((ref, i) => (
                  <button key={`${ref.url}-${i}`} type="button" onClick={() => setPreview(ref.url)} title={ref.alt || `参考图 ${i + 1}`}>
                    <img src={ref.url} alt={ref.alt || `Reference ${i + 1}`} />
                  </button>
                ))}
              </div>
            )}
          </article>
        )
      })}
      {(thinkingText || streamingText) && (
        <article className="message assistant streaming-message">
          {thinkingText && <details><summary>思考</summary><pre>{thinkingText}</pre></details>}
          {streamingText && <MarkdownText text={streamingText} />}
        </article>
      )}
      {toolDraft && (
        <article className="task-card tool-draft-card">
          <div className="task-meta"><span>{translate(locale, `tool.${toolDraft.phase}`)}</span><Loader2 className="spin" size={16} /></div>
          {toolDraft.prompt && <details open><summary>{translate(locale, 'tool.prompt')}</summary><pre>{toolDraft.prompt}</pre></details>}
        </article>
      )}
      {latestTask && (
        <article className="task-card">
          {latestTask.status !== 'completed' && (
            <>
              <div className="task-meta"><span>{localizeStatus(locale, latestTask.status)}</span><strong>{latestTask.progress}%</strong></div>
              <div className="progress"><span style={{ width: `${Math.max(latestTask.progress, 8)}%` }} /></div>
            </>
          )}
          {latestTask.error && <p className="form-error">{latestTask.error}</p>}
          {resultImages.length > 0 && (
            <div className="result-grid">
              {resultImages.map((url) => (
                <button key={url} onClick={() => setPreview(url)} title="预览"><img src={url} alt="Generated" /></button>
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

// ── Composer ──

function Composer({ sessionId, assets, onChanged, onEnsureSession, setStreamingText, setThinkingText, setStreamingSessionId, setToolDraft, setOptimisticMessages, pendingRequest, setPendingRequest, conversationStarted, runtimeSettings }: {
  sessionId: number | null; assets: Asset[]; conversationStarted: boolean
  onChanged: () => void | Promise<void>
  onEnsureSession: () => Promise<Session | null>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setThinkingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingSessionId: React.Dispatch<React.SetStateAction<number | null>>
  setToolDraft: React.Dispatch<React.SetStateAction<ToolDraft | null>>
  setOptimisticMessages: React.Dispatch<React.SetStateAction<Record<number, Message[]>>>
  pendingRequest: PendingRequest | null
  setPendingRequest: React.Dispatch<React.SetStateAction<PendingRequest | null>>
  runtimeSettings: RuntimeSettings | null
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assetGalleryOpen, setAssetGalleryOpen] = useState(false)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [galleryPreview, setGalleryPreview] = useState<string | null>(null)
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
  const [plannerProvider, setPlannerProvider] = useState('')
  const [plannerModel, setPlannerModel] = useState('')
  const [imageProvider, setImageProvider] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const visibleAssets = useMemo(() => uniqueAssets(assets), [assets])
  const galleryAssets = useMemo(() => uniqueAssets([...visibleAssets, ...libraryAssets]), [visibleAssets, libraryAssets])
  const selectedAssets = galleryAssets.filter((a) => selectedAssetIds.includes(a.id))
  const composerCentered = !conversationStarted
  const greeting = useMemo(() => buildComposerGreeting(user), [user?.display_name, user?.email])
  const selectedPlannerProvider = plannerProvider || runtimeSettings?.defaults.planner_provider || ''
  const selectedPlannerModel = plannerModel || runtimeSettings?.defaults.planner_model || ''
  const selectedImageProvider = imageProvider || runtimeSettings?.defaults.image_provider || ''

  const parsedCommands = useMemo(() => parseCommands(draft), [draft])
  const hasCommandOverrides = Object.keys(parsedCommands.overrides).length > 0

  useEffect(() => {
    if (!runtimeSettings) return
    if (!uploadProvider || !runtimeSettings.upload_providers.some((p) => p.id === uploadProvider)) {
      setUploadProvider(runtimeSettings.defaults.upload_provider)
    }
  }, [runtimeSettings?.defaults.upload_provider])

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
    setAssetGalleryOpen((o) => !o)
    setSettingsOpen(false)
    if (!assetGalleryOpen) loadAssetGallery()
  }

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }, [draft])

  useEffect(() => {
    if (!settingsOpen && !assetGalleryOpen) return
    function handleClick(event: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false)
        setAssetGalleryOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [settingsOpen, assetGalleryOpen])

  async function ensureTargetSession() {
    if (sessionId) return sessionId
    try {
      const session = await onEnsureSession()
      return session?.id ?? null
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建会话失败')
      return null
    }
  }

  async function requestGenerate(
    targetSessionId: number, message: string, assetIds: number[], baseSettings: typeof settings,
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
        message, asset_ids: assetIds, use_planner: usePlanner,
        planner_provider: selectedPlannerProvider, planner_model: selectedPlannerModel, image_provider: selectedImageProvider,
        ...baseSettings, ...extra,
      })
      if (res.requires_confirmation) {
        setPendingRequest({ sessionId: targetSessionId, response: res, message, assetIds, settings: baseSettings })
        return
      }
      if (res.generated || res.message) { setDraft(''); clearSelectedAssets() }
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
    if (!draft.trim()) return
    setBusy(true)
    setError('')
    let submittedSessionId: number | null = sessionId
    let keepStream = false
    let completed = false
    let toolUsed = false
    try {
      const targetSessionId = await ensureTargetSession()
      if (!targetSessionId) return
      submittedSessionId = targetSessionId
      const { cleanText, overrides } = parseCommands(draft)
      const submitted = cleanText.trim() || draft.trim()
      const submittedAssetIds = [...selectedAssetIds]
      const submittedSettings = { ...settings, ...overrides }
      const submittedAssets = assets.filter((a) => submittedAssetIds.includes(a.id))
      const now = new Date().toISOString()
      setOptimisticMessages((items) => ({
        ...items,
        [targetSessionId]: [{ id: -Date.now(), session_id: targetSessionId, role: 'user', content: withReferenceMarkdown(submitted, submittedAssets), created_at: now }],
      }))
      setDraft('')
      clearSelectedAssets()
      setStreamingSessionId(targetSessionId)
      setStreamingText('')
      setThinkingText('')
      setToolDraft(null)
      await api.generateStream(targetSessionId, {
        message: submitted, asset_ids: submittedAssetIds, use_planner: usePlanner,
        planner_provider: selectedPlannerProvider, planner_model: selectedPlannerModel, image_provider: selectedImageProvider,
        ...submittedSettings,
      }, (event) => {
        if (event.type === 'content') setStreamingText((t) => t + event.text)
        else if (event.type === 'thinking') setThinkingText((t) => t + event.text)
        else if (event.type === 'confirm') {
          keepStream = true; toolUsed = true
          setPendingRequest({ sessionId: targetSessionId, response: event, message: submitted, assetIds: submittedAssetIds, settings: submittedSettings })
        } else if (event.type === 'done') {
          completed = true
          if (event.plan?.tool_called) {
            toolUsed = true
            setToolDraft((c) => c?.sessionId === targetSessionId
              ? { ...c, phase: 'calling', prompt: event.plan.prompt || c.prompt }
              : { sessionId: targetSessionId, phase: 'calling', prompt: event.plan.prompt, raw: '' })
          }
        } else if (event.type === 'error') setError(event.error)
        else if (event.type === 'tool') {
          toolUsed = true
          setToolDraft((c) => ({ sessionId: targetSessionId, phase: event.phase, raw: (c?.sessionId === targetSessionId ? c.raw : '') + (event.text ?? ''), prompt: event.prompt ?? c?.prompt ?? '' }))
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
      if (completed) {
        await onChanged()
        const sessionIdForCleanup = submittedSessionId
        if (sessionIdForCleanup !== null) {
          setOptimisticMessages((items) => ({ ...items, [sessionIdForCleanup]: [] }))
        }
      }
      if (!keepStream && !toolUsed) { setStreamingText(''); setThinkingText(''); setStreamingSessionId(null); setToolDraft(null) }
    }
  }

  async function confirmWith(nextSettings: typeof settings) {
    if (!pendingRequest) return
    await requestGenerate(pendingRequest.sessionId, pendingRequest.message, pendingRequest.assetIds, pendingRequest.settings, {
      ...nextSettings, confirmed: true, prompt: pendingRequest.response.plan.prompt, assistant_message: pendingRequest.response.plan.assistant_message,
    })
    setPendingRequest(null)
  }

  async function uploadFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return
    const targetSessionId = await ensureTargetSession()
    if (!targetSessionId) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          const res = await api.uploadAsset(targetSessionId, file, uploadProvider)
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
    const targetSessionId = await ensureTargetSession()
    if (!targetSessionId) return
    setError('')
    try {
      if (asset.session_id === targetSessionId) { toggleAsset(asset.id); return }
      const res = await api.useAsset(targetSessionId, asset.id)
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
            <span className="greeting-logo"><Sparkles size={22} /></span>
            <h2>{greeting}</h2>
          </div>
        )}
        {selectedAssets.length > 0 && (
          <div className="selected-strip">
            {selectedAssets.map((asset, i) => (
              <span key={asset.id} title={asset.file_name}>
                <img src={assetImageSrc(asset)} alt={asset.file_name} />
                图{i + 1}
                <button type="button" className="selected-remove" onClick={() => deselectAsset(asset.id)} title="移除"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-box">
          <input ref={fileInputRef} className="hidden-file" type="file" accept="image/*" multiple onChange={(e) => { uploadFiles(e.target.files); e.currentTarget.value = '' }} />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
              if (files.length > 0) { e.preventDefault(); uploadFiles(files) }
            }}
            placeholder="描述你想要的画面…"
            rows={1}
          />
          {hasCommandOverrides && (
            <div className="param-tags">
              {Object.entries(parsedCommands.overrides).map(([k, v]) => <span key={k} className="param-tag">{k}: {String(v)}</span>)}
            </div>
          )}
          <div className="composer-actions" ref={actionsRef}>
            <button type="button" className="icon-button" onClick={openAssetGallery} title="参考图库">
              {uploading ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
            </button>
            <button type="button" className="icon-button" onClick={() => { setSettingsOpen((o) => !o); setAssetGalleryOpen(false) }} title="生成参数">
              <SlidersHorizontal size={18} />
            </button>
            {settingsOpen && (
              <SettingsPopover settings={settings} setSettings={setSettings} usePlanner={usePlanner} setUsePlanner={setUsePlanner}
                runtimeSettings={runtimeSettings} plannerProvider={selectedPlannerProvider} setPlannerProvider={setPlannerProvider}
                plannerModel={selectedPlannerModel} setPlannerModel={setPlannerModel} imageProvider={selectedImageProvider} setImageProvider={setImageProvider}
                onClose={() => setSettingsOpen(false)} />
            )}
            {assetGalleryOpen && (
              <AssetGalleryPopover
                assets={galleryAssets} selectedAssetIds={selectedAssetIds} uploadProvider={uploadProvider} setUploadProvider={setUploadProvider}
                runtimeSettings={runtimeSettings}
                uploading={uploading} loading={libraryLoading} onUpload={chooseUploadFiles} onUse={useGalleryAsset}
                onPreview={(a) => setGalleryPreview(assetImageSrc(a))} onClose={() => setAssetGalleryOpen(false)}
              />
            )}
            <label className="planner-switch" title="AI Planner 会自动优化你的参数和 prompt">
              <span>Planner</span>
              <input type="checkbox" checked={usePlanner} onChange={(e) => setUsePlanner(e.target.checked)} />
            </label>
            <button type="button" className="icon-button mobile-tools-button" onClick={() => setMobileToolsOpen(true)} title="参数"><Settings2 size={18} /></button>
            <button className="send-button" disabled={busy || !draft.trim()} title="发送">
              {busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
      {mobileToolsOpen && (
        <MobileMoreDrawer assets={visibleAssets} selectedAssetIds={selectedAssetIds} toggleAsset={toggleAsset}
          settings={settings} setSettings={setSettings} usePlanner={usePlanner} setUsePlanner={setUsePlanner}
          onClose={() => setMobileToolsOpen(false)} onUpload={() => { setMobileToolsOpen(false); setAssetGalleryOpen(true); loadAssetGallery() }} />
      )}
      {galleryPreview && <ImageLightbox src={galleryPreview} onClose={() => setGalleryPreview(null)} />}
      {pendingRequest?.response.requires_confirmation && (
        <PlanConfirmDialog
          plan={pendingRequest.response.plan} settings={pendingRequest.settings}
          onAccept={() => confirmWith({ size: pendingRequest.response.plan.size, resolution: pendingRequest.response.plan.resolution, quality: pendingRequest.response.plan.quality, count: pendingRequest.response.plan.count })}
          onKeepMine={() => confirmWith(pendingRequest.settings)}
          onCancel={() => {
            setPendingRequest(null)
            setOptimisticMessages((items) => ({ ...items, [pendingRequest.sessionId]: [] }))
            setStreamingText(''); setThinkingText(''); setStreamingSessionId(null); setError('已取消')
          }}
        />
      )}
    </>
  )
}

// ── Popovers & Dialogs ──

function SettingsPopover({ settings, setSettings, usePlanner, setUsePlanner, runtimeSettings, plannerProvider, setPlannerProvider, plannerModel, setPlannerModel, imageProvider, setImageProvider, onClose }: {
  settings: GenerationSettingsValue; setSettings: (s: Partial<GenerationSettingsValue>) => void
  usePlanner: boolean; setUsePlanner: (v: boolean) => void; runtimeSettings: RuntimeSettings | null
  plannerProvider: string; setPlannerProvider: (v: string) => void; plannerModel: string; setPlannerModel: (v: string) => void
  imageProvider: string; setImageProvider: (v: string) => void; onClose: () => void
}) {
  const plannerProviders = runtimeSettings?.llm_providers.filter((p) => p.enabled && p.allow_user_select) ?? []
  const selectedPlannerId = plannerProvider || runtimeSettings?.defaults.planner_provider || ''
  return (
    <div className="settings-popover" onClick={(e) => e.stopPropagation()}>
      <div className="settings-popover-head">
        <strong>生成参数</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
      </div>
      <SettingsControls settings={settings} setSettings={setSettings} />
      <label className="switch-row">
        <span>AI Planner</span>
        <input type="checkbox" checked={usePlanner} onChange={(e) => setUsePlanner(e.target.checked)} />
      </label>
      {runtimeSettings && (
        <div className="settings-controls planner-settings-controls">
          <label>
            Planner 模型
            <select value={selectedPlannerId} onChange={(e) => {
              const next = runtimeSettings.llm_providers.find((p) => p.id === e.target.value)
              setPlannerProvider(e.target.value)
              setPlannerModel(next?.planner_model || '')
            }}>
              {plannerProviders.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </label>
          <label>
            图片 provider
            <select value={imageProvider} onChange={(e) => setImageProvider(e.target.value)}>
              {runtimeSettings.image_providers.filter((p) => p.enabled && p.allow_user_select).map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

function SettingsControls({ settings, setSettings }: { settings: GenerationSettingsValue; setSettings: (s: Partial<GenerationSettingsValue>) => void }) {
  const locale = useAppStore((s) => s.locale)
  return (
    <div className="settings-controls">
      <label title="比例为 auto 时，resolution 不参与尺寸推导。">
        比例
        <select value={settings.size} onChange={(e) => setSettings({ size: e.target.value })}>
          {['auto', '1:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '21:9'].map((i) => <option key={i}>{i}</option>)}
        </select>
      </label>
      <label title="1K/2K/4K 只在比例尺寸下生效。">
        清晰度
        <select value={settings.resolution} onChange={(e) => setSettings({ resolution: e.target.value })}>
          {['1K', '2K', '4K'].map((i) => <option key={i}>{i}</option>)}
        </select>
      </label>
      <label title="high 约为 medium 的 4 倍成本。">
        质量
        <select value={settings.quality} onChange={(e) => setSettings({ quality: e.target.value })}>
          {['low', 'medium', 'high'].map((i) => <option key={i} value={i}>{localizeQuality(locale, i)}</option>)}
        </select>
      </label>
      <label title="每张输出独立计费。">
        数量
        <input type="number" min={1} max={4} value={settings.count} onChange={(e) => setSettings({ count: Number(e.target.value) })} />
      </label>
    </div>
  )
}

function AssetGalleryPopover({ assets, selectedAssetIds, uploadProvider, setUploadProvider, runtimeSettings, uploading, loading, onUpload, onUse, onPreview, onClose }: {
  assets: Asset[]; selectedAssetIds: number[]; uploadProvider: string; setUploadProvider: (p: string) => void
  runtimeSettings: RuntimeSettings | null; uploading: boolean; loading: boolean; onUpload: () => void; onUse: (a: Asset) => void | Promise<void>; onPreview: (a: Asset) => void; onClose: () => void
}) {
  return (
    <div className="asset-gallery-popover" onClick={(e) => e.stopPropagation()}>
      <div className="asset-gallery-head">
        <strong>参考图库</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
      </div>
      <label className="asset-gallery-provider">
        上传到
        <select value={uploadProvider} onChange={(e) => setUploadProvider(e.target.value)}>
          {(runtimeSettings?.upload_providers.filter((p) => p.enabled) ?? [{ id: 'evolink', name: 'Evolink' }, { id: 'maxqi', name: 'MaxQi' }]).map((p) => (
            <option key={p.id} value={p.id}>{p.name || p.id}</option>
          ))}
        </select>
      </label>
      <div className="asset-gallery-grid">
        <button type="button" className="asset-upload-tile" onClick={onUpload} title="上传">
          {uploading ? <Loader2 className="spin" size={20} /> : <ImagePlus size={20} />}
        </button>
        {assets.map((asset) => (
          <div key={asset.id} className={`asset-tile compact ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`} title={asset.file_name}>
            <img src={assetImageSrc(asset)} alt={asset.file_name} />
            <button className="asset-use" type="button" onClick={() => onUse(asset)} title="使用">
              {selectedAssetIds.includes(asset.id) ? '已用' : '使用'}
            </button>
            <button className="asset-preview-hit" type="button" onClick={() => onPreview(asset)} title="预览" />
          </div>
        ))}
        {loading && <div className="asset-gallery-loading"><Loader2 className="spin" size={18} /></div>}
      </div>
      {!loading && assets.length === 0 && <p className="empty-note">还没有参考图</p>}
    </div>
  )
}

function PlanConfirmDialog({ plan, settings, onAccept, onKeepMine, onCancel }: {
  plan: GenerationPlan; settings: GenerationSettingsValue
  onAccept: () => void; onKeepMine: () => void; onCancel: () => void
}) {
  const locale = useAppStore((s) => s.locale)
  const changed = plan.size !== settings.size || plan.resolution !== settings.resolution || plan.quality !== settings.quality || plan.count !== settings.count
  return (
    <div className="overlay">
      <section className="overlay-panel confirm-panel">
        <header>
          <h2>AI 建议调整参数</h2>
          <button className="icon-button" onClick={onCancel} title="取消"><X size={18} /></button>
        </header>
        <div className="overlay-body">
          <div className="plan-confirm-body">
            {changed && (
              <div className="plan-confirm-comparison">
                <div className="plan-confirm-side">
                  <h4>你的参数</h4>
                  <div className="param-row"><span>比例</span><span>{settings.size}</span></div>
                  <div className="param-row"><span>清晰度</span><span>{settings.resolution}</span></div>
                  <div className="param-row"><span>质量</span><span>{localizeQuality(locale, settings.quality)}</span></div>
                  <div className="param-row"><span>数量</span><span>{settings.count}</span></div>
                </div>
                <div className="plan-confirm-side">
                  <h4>AI 建议</h4>
                  <div className="param-row"><span>比例</span><span>{plan.size}</span></div>
                  <div className="param-row"><span>清晰度</span><span>{plan.resolution}</span></div>
                  <div className="param-row"><span>质量</span><span>{localizeQuality(locale, plan.quality)}</span></div>
                  <div className="param-row"><span>数量</span><span>{plan.count}</span></div>
                </div>
              </div>
            )}
            {plan.prompt && <details><summary>Prompt</summary><pre>{plan.prompt}</pre></details>}
            <div className="confirm-actions">
              <button className="secondary-button" onClick={onKeepMine}>保持我的参数</button>
              <button className="primary-button" onClick={onAccept}>采用建议并生成</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function MobileMoreDrawer({ assets, selectedAssetIds, toggleAsset, settings, setSettings, usePlanner, setUsePlanner, onClose, onUpload }: {
  assets: Asset[]; selectedAssetIds: number[]; toggleAsset: (id: number) => void
  settings: GenerationSettingsValue; setSettings: (s: Partial<GenerationSettingsValue>) => void
  usePlanner: boolean; setUsePlanner: (v: boolean) => void; onClose: () => void; onUpload: () => void
}) {
  const [page, setPage] = useState(0)
  const touchStartX = useRef<number | null>(null)
  function finishSwipe(x: number) {
    if (touchStartX.current === null) return
    const delta = x - touchStartX.current
    if (Math.abs(delta) > 46) setPage((c) => (delta < 0 ? Math.min(1, c + 1) : Math.max(0, c - 1)))
    touchStartX.current = null
  }
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <section className="more-drawer" onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => { touchStartX.current = e.touches[0]?.clientX ?? null }}
        onTouchEnd={(e) => finishSwipe(e.changedTouches[0]?.clientX ?? 0)}>
        <div className="drawer-handle" />
        <header className="drawer-head">
          <h2>更多</h2>
          <div className="drawer-tabs" role="tablist">
            <button type="button" className={page === 0 ? 'active' : ''} onClick={() => setPage(0)}>功能</button>
            <button type="button" className={page === 1 ? 'active' : ''} onClick={() => setPage(1)}>参数</button>
          </div>
        </header>
        <div className="drawer-pages">
          <div className="drawer-track" style={{ transform: `translateX(-${page * 50}%)` }}>
            <div className="drawer-page">
              <label className="switch-row drawer-switch"><span>AI Planner</span><input type="checkbox" checked={usePlanner} onChange={(e) => setUsePlanner(e.target.checked)} /></label>
              <button type="button" className="drawer-tool" onClick={onUpload}><ImagePlus size={22} /><span>上传参考图</span></button>
              {assets.length > 0 && (
                <div className="drawer-assets">
                  {assets.map((a) => (
                    <button key={a.id} className={selectedAssetIds.includes(a.id) ? 'selected' : ''} onClick={() => toggleAsset(a.id)} title={a.file_name} type="button">
                      <img src={assetImageSrc(a)} alt={a.file_name} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="drawer-page"><SettingsControls settings={settings} setSettings={setSettings} /></div>
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

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-frame" onClick={(e) => e.stopPropagation()}>
        <button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <img src={src} alt="Preview" />
      </div>
    </div>
  )
}

function Overlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="overlay">
      <section className="overlay-panel">
        <header><h2>{title}</h2><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></header>
        <div className="overlay-body">{children}</div>
      </section>
    </div>
  )
}

function Metric({ label, value, valueText }: { label: string; value?: number; valueText?: string }) {
  return <div className="metric"><span>{label}</span><strong>{valueText ?? value}</strong></div>
}

function UsageBar({ bucket, maxCredits, granularity }: { bucket: UsageBucket; maxCredits: number; granularity: 'hour' | 'day' }) {
  const height = Math.max((bucket.credits / maxCredits) * 100, 4)
  const imagePct = bucket.credits > 0 ? (bucket.image_credits / bucket.credits) * 100 : 0
  const textPct = bucket.credits > 0 ? (bucket.text_credits / bucket.credits) * 100 : 0
  const label = granularity === 'hour' ? bucket.period.slice(5, 16) : bucket.period.slice(5)
  return (
    <div className="usage-bar-wrap" title={`${bucket.period}: 图片 ${bucket.image_credits}，文本 ${bucket.text_credits}，合计 ${bucket.credits}`}>
      <div className="usage-bar" style={{ height: `${height}%` }}>
        {bucket.image_credits > 0 && <span className="usage-bar-image" style={{ height: `${imagePct}%` }} />}
        {bucket.text_credits > 0 && <span className="usage-bar-text" style={{ height: `${textPct}%` }} />}
      </div>
      <span className="chart-label">{label}</span>
    </div>
  )
}

// ── Pages ──

function ChatsPage({ sessions, onSelect, onArchive, onRefresh }: {
  sessions: Session[]; onSelect: (id: number) => void; onArchive: (id: number) => Promise<void>; onRefresh: () => Promise<void>
}) {
  const [allSessions, setAllSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const locale = useAppStore((s) => s.locale)

  useEffect(() => {
    api.listAllSessions().then((r) => setAllSessions(r.sessions ?? [])).catch((e) => setError(e.message))
  }, [])

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase()
    if (!kw) return allSessions
    return allSessions.filter((s) => s.title.toLowerCase().includes(kw))
  }, [allSessions, query])

  const activeCount = allSessions.filter((s) => !s.archived_at).length
  const archivedCount = allSessions.length - activeCount

  async function handleArchive(session: Session) {
    setError('')
    try {
      if (session.archived_at) await api.unarchiveSession(session.id)
      else await api.archiveSession(session.id)
      const res = await api.listAllSessions()
      setAllSessions(res.sessions ?? [])
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleDelete(session: Session) {
    if (!window.confirm(`彻底删除「${session.title}」？不可恢复。`)) return
    setError('')
    try {
      await api.deleteSession(session.id)
      const res = await api.listAllSessions()
      setAllSessions(res.sessions ?? [])
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    if (days === 1) return '昨天'
    if (days < 3) return `${days} 天前`
    return new Date(dateStr).toLocaleDateString()
  }

  return (
    <div className="page-shell page-shell-fixed page-shell-medium page-shell-centered-header">
      <div className="page-header">
        <h1 className="page-title">对话</h1>
        <p className="page-subtitle">搜索和管理你的所有对话</p>
      </div>
      <div className="chats-page">
        <div className="chats-search-bar">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索对话…" autoFocus />
        </div>
        <div className="chats-stats">
          <span>{activeCount} 个活跃</span>
          <span>{archivedCount} 个归档</span>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="chats-list">
          {filtered.map((session) => (
            <div key={session.id} className="chat-item">
              <button type="button" className="chat-item-info" onClick={() => onSelect(session.id)} style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
                <strong>{session.title}</strong>
                <span>最后活跃 {timeAgo(session.updated_at)}{session.archived_at ? ' · 已归档' : ''}</span>
              </button>
              <div className="chat-item-actions">
                <button className="icon-button" onClick={() => handleArchive(session)} title={session.archived_at ? '恢复' : '归档'}>
                  {session.archived_at ? <RotateCcw size={15} /> : <Archive size={15} />}
                </button>
                <button className="icon-button danger-button" onClick={() => handleDelete(session)} title="删除"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <p className="empty-note" style={{ padding: '20px 8px' }}>没有匹配的对话</p>}
        </div>
      </div>
    </div>
  )
}

function CanvasPage({ detail, sessionId, runtimeSettings, onChanged, onRename, onOpenMenu }: {
  detail: SessionDetail | null
  sessionId: number
  runtimeSettings: RuntimeSettings | null
  onChanged: () => void | Promise<void>
  onRename: (title: string) => Promise<void>
  onOpenMenu: () => void
}) {
  const settings = useAppStore((s) => s.settings)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const setUploadProvider = useAppStore((s) => s.setUploadProvider)
  const [canvas, setCanvas] = useState<CanvasState>(emptyCanvasState())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [promptDraft, setPromptDraft] = useState('')
  const [removePrompt, setRemovePrompt] = useState(defaultRemoveBackgroundPrompt)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ type: 'node' | 'pan'; id?: string; startX: number; startY: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const sessionRef = useRef<number | null>(null)
  const canvasStateRef = useRef<string | undefined>(undefined)
  const selected = canvas.nodes.find((node) => node.id === selectedId) ?? null
  const imageProvider = runtimeSettings?.defaults.image_provider || ''

  function queueSave(next: CanvasState) {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      api.updateSessionCanvas(sessionId, next).catch((err) => setError(err instanceof Error ? err.message : '画布保存失败'))
    }, 450)
  }

  function updateCanvas(updater: (current: CanvasState) => CanvasState) {
    setCanvas((current) => {
      const next = updater(current)
      queueSave(next)
      return next
    })
  }

  useEffect(() => {
    const sources = canvasNodesFromDetail(detail)
    const raw = detail?.session.canvas_state
    setCanvas((current) => {
      const changedSession = sessionRef.current !== sessionId
      const changedState = canvasStateRef.current !== raw
      sessionRef.current = sessionId
      canvasStateRef.current = raw
      if (changedSession || changedState) return mergeCanvasState(parseCanvasState(raw), sources)
      return mergeCanvasState(current, sources)
    })
  }, [sessionId, detail?.session.canvas_state, detail?.assets, detail?.tasks])

  useEffect(() => {
    if (!selected) {
      setPromptDraft('')
      return
    }
    setPromptDraft(selected.prompt || '')
  }, [selected?.id])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
  }, [])

  async function loadLibrary() {
    setLibraryOpen((open) => !open)
    try {
      const res = await api.listAssets()
      setLibraryAssets(res.assets ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '图库加载失败')
    }
  }

  async function uploadFiles(files: FileList | File[] | null) {
    if (!files?.length) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue
        const res = await api.uploadAsset(sessionId, file, uploadProvider)
        const node = nodeFromAsset(res.asset, canvas.nodes.length)
        updateCanvas((current) => ({ ...current, nodes: upsertCanvasNode(current.nodes, node) }))
      }
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function addLibraryAsset(asset: Asset) {
    setError('')
    try {
      const res = asset.session_id === sessionId ? { asset } : await api.useAsset(sessionId, asset.id)
      const node = nodeFromAsset(res.asset, canvas.nodes.length)
      updateCanvas((current) => ({ ...current, nodes: upsertCanvasNode(current.nodes, node) }))
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加图片失败')
    }
  }

  function updateSelectedPrompt(value: string) {
    setPromptDraft(value)
    if (!selected) return
    updateCanvas((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === selected.id ? { ...node, prompt: value } : node)),
    }))
  }

  async function generateFromPrompt(prompt: string, assetIDs: number[]) {
    const text = prompt.trim()
    if (!text) {
      setError('请先填写提示词')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.generate(sessionId, {
        message: text,
        asset_ids: assetIDs,
        size: settings.size,
        resolution: settings.resolution,
        quality: settings.quality,
        count: settings.count,
        use_planner: false,
        image_provider: imageProvider,
      })
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function removeBackgroundLocal() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const dataURL = await removeBackgroundFromURL(selected.url)
      const node: CanvasNode = {
        ...selected,
        id: `local-${Date.now()}`,
        source: 'local',
        asset_id: undefined,
        task_id: undefined,
        image_index: undefined,
        url: dataURL,
        title: `${selected.title} 去背景`,
        x: selected.x + 36,
        y: selected.y + 36,
      }
      updateCanvas((current) => ({ ...current, nodes: [node, ...current.nodes] }))
      setSelectedId(node.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '本地去背景失败')
    } finally {
      setBusy(false)
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    dragRef.current = { type: 'pan', startX: event.clientX, startY: event.clientY, x: 0, y: 0, panX: canvas.panX, panY: canvas.panY }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedId(null)
  }

  function handleNodePointerDown(event: React.PointerEvent<HTMLDivElement>, node: CanvasNode) {
    event.stopPropagation()
    dragRef.current = { type: 'node', id: node.id, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y, panX: canvas.panX, panY: canvas.panY }
    stageRef.current?.setPointerCapture(event.pointerId)
    setSelectedId(node.id)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    updateCanvas((current) => {
      if (drag.type === 'pan') {
        return { ...current, panX: drag.panX + event.clientX - drag.startX, panY: drag.panY + event.clientY - drag.startY }
      }
      const dx = (event.clientX - drag.startX) / current.zoom
      const dy = (event.clientY - drag.startY) / current.zoom
      return {
        ...current,
        nodes: current.nodes.map((node) => (node.id === drag.id ? { ...node, x: drag.x + dx, y: drag.y + dy } : node)),
      }
    })
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null
    if (stageRef.current?.hasPointerCapture(event.pointerId)) stageRef.current.releasePointerCapture(event.pointerId)
  }

  function zoomAt(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const nextZoom = clamp(canvas.zoom * (event.deltaY < 0 ? 1.08 : 0.92), 0.2, 3)
    const worldX = (event.clientX - rect.left - canvas.panX) / canvas.zoom
    const worldY = (event.clientY - rect.top - canvas.panY) / canvas.zoom
    updateCanvas((current) => ({
      ...current,
      zoom: nextZoom,
      panX: event.clientX - rect.left - worldX * nextZoom,
      panY: event.clientY - rect.top - worldY * nextZoom,
    }))
  }

  const selectedAssetIDs = selected?.asset_id ? [selected.asset_id] : []

  return (
    <section className="canvas-panel">
      <header className="topbar canvas-topbar">
        <button className="icon-button mobile-only" onClick={onOpenMenu} title="菜单"><PanelLeft size={18} /></button>
        {detail?.session ? <EditableTitle title={detail.session.title} onSave={onRename} /> : <div className="title-line"><h1>新建画布</h1></div>}
        <div className="canvas-zoom-controls">
          <button className="icon-button" type="button" onClick={() => updateCanvas((c) => ({ ...c, zoom: clamp(c.zoom - 0.1, 0.2, 3) }))} title="缩小"><ZoomOut size={17} /></button>
          <span>{Math.round(canvas.zoom * 100)}%</span>
          <button className="icon-button" type="button" onClick={() => updateCanvas((c) => ({ ...c, zoom: clamp(c.zoom + 0.1, 0.2, 3) }))} title="放大"><ZoomIn size={17} /></button>
        </div>
      </header>
      {error && <p className="inline-error">{error}</p>}
      <div className="canvas-layout">
        <div
          ref={stageRef}
          className="canvas-stage"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={zoomAt}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); uploadFiles(event.dataTransfer.files) }}
        >
          <div className="canvas-grid" style={{ transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})` }}>
            {canvas.nodes.map((node) => (
              <div
                key={node.id}
                className={`canvas-node ${node.id === selectedId ? 'selected' : ''}`}
                style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
              >
                <img src={node.url} alt={node.title} draggable={false} />
                <span>{node.title}</span>
              </div>
            ))}
          </div>
          {canvas.nodes.length === 0 && (
            <div className="canvas-empty">
              <Move size={24} />
              <p>把图片拖到这里，或从右侧添加图片</p>
            </div>
          )}
        </div>
        <aside className="canvas-inspector">
          <div className="canvas-inspector-head">
            <strong>{selected ? '图像信息' : '画布'}</strong>
            <button className="icon-button" type="button" onClick={() => updateCanvas(() => emptyCanvasState())} title="清空画布"><Minus size={16} /></button>
          </div>
          <div className="canvas-tools">
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="spin" size={16} /> : <ImagePlus size={16} />}
              上传图片
            </button>
            <button className="secondary-button" type="button" onClick={loadLibrary}>图库</button>
            <label className="upload-destination-inline">
              上传到
              <select value={uploadProvider} onChange={(e) => setUploadProvider(e.target.value)}>
                {(runtimeSettings?.upload_providers.filter((p) => p.enabled) ?? [{ id: 'evolink', name: 'Evolink' }, { id: 'maxqi', name: 'MaxQi' }]).map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </label>
            <input ref={fileInputRef} className="hidden-file" type="file" accept="image/*" multiple onChange={(e) => { uploadFiles(e.target.files); e.currentTarget.value = '' }} />
          </div>
          {libraryOpen && (
            <div className="canvas-library">
              {libraryAssets.map((asset) => (
                <button key={asset.id} type="button" onClick={() => addLibraryAsset(asset)} title={asset.file_name}>
                  <img src={assetImageSrc(asset)} alt={asset.file_name} />
                </button>
              ))}
              {libraryAssets.length === 0 && <p className="empty-note">图库里还没有图片</p>}
            </div>
          )}
          {selected ? (
            <div className="canvas-selected">
              <img src={selected.url} alt={selected.title} />
              <div className="param-row"><span>来源</span><span>{selected.source === 'asset' ? '参考图' : selected.source === 'task' ? '生成图' : '本地图'}</span></div>
              <label>
                提示词
                <textarea value={promptDraft} onChange={(e) => updateSelectedPrompt(e.target.value)} placeholder="为这张图记录或修改提示词" />
              </label>
              <div className="canvas-action-stack">
                <button className="primary-button" type="button" disabled={busy} onClick={() => generateFromPrompt(promptDraft, selectedAssetIDs)}>
                  {busy ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
                  创建新图片
                </button>
                <button className="secondary-button" type="button" disabled={busy} onClick={removeBackgroundLocal}>本地去背景</button>
              </div>
              <label>
                AI 去背景提示词
                <textarea value={removePrompt} onChange={(e) => setRemovePrompt(e.target.value)} />
              </label>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => generateFromPrompt(removePrompt, selectedAssetIDs)}>AI 去背景</button>
              {!selected.asset_id && <p className="empty-note">AI 去背景会使用提示词生成；生成图作为参考图复用还需要后续把任务结果保存成资产。</p>}
            </div>
          ) : (
            <div className="canvas-selected empty">
              <p className="empty-note">选择一张图片后，可以编辑提示词、创建新图片或去背景。</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}

function GalleryPage({ activeSessionId, onSessionsChanged, runtimeSettings }: { activeSessionId: number | null; onSessionsChanged: () => void | Promise<void>; runtimeSettings: RuntimeSettings | null }) {
  const [data, setData] = useState<UsageResponse | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'generated' | 'uploaded'>('generated')
  const selectAsset = useAppStore((s) => s.selectAsset)
  const deselectAsset = useAppStore((s) => s.deselectAsset)
  const uploadProvider = useAppStore((s) => s.uploadProvider)
  const setUploadProvider = useAppStore((s) => s.setUploadProvider)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const allGalleryItems = useMemo(() => galleryItemsFromUsage(data), [data])
  const galleryItems = useMemo(() => {
    if (filter === 'generated') return allGalleryItems.filter((item) => item.generated)
    if (filter === 'uploaded') return allGalleryItems.filter((item) => item.kind === 'asset' && !item.generated)
    return allGalleryItems
  }, [allGalleryItems, filter])

  async function load() {
    const res = await api.usage()
    setData(res)
  }

  useEffect(() => { load().catch((e) => setError(e.message)) }, [])

  async function uploadFiles(files: FileList | null) {
    if (!activeSessionId || !files?.length) {
      setError('请先选择一个对话再上传')
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
      await Promise.all([load(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function useAsset(asset: Asset) {
    if (!activeSessionId) return
    setError('')
    try {
      const res = await api.useAsset(activeSessionId, asset.id)
      selectAsset(res.asset.id)
      await Promise.all([load(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function deleteAsset(asset: Asset) {
    setError('')
    try {
      await api.deleteAsset(asset.id)
      deselectAsset(asset.id)
      await Promise.all([load(), onSessionsChanged()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="page-shell page-shell-fixed page-shell-wide page-shell-centered-header">
      <div className="page-header">
        <h1 className="page-title">画廊</h1>
        <p className="page-subtitle">你的所有参考图和生成作品</p>
      </div>
      <div className="gallery-page">
        <div className="gallery-toolbar">
          <div className="gallery-filters">
            <button type="button" className={filter === 'generated' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter('generated')}>生成</button>
            <button type="button" className={filter === 'all' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter('all')}>全部 ({allGalleryItems.length})</button>
            <button type="button" className={filter === 'uploaded' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter('uploaded')}>上传</button>
          </div>
          <div className="gallery-actions">
            <label>
              上传到
              <select value={uploadProvider} onChange={(e) => setUploadProvider(e.target.value)}>
                {(runtimeSettings?.upload_providers.filter((p) => p.enabled) ?? [{ id: 'evolink', name: 'Evolink' }, { id: 'maxqi', name: 'MaxQi' }]).map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </label>
            <button type="button" className="primary-button" onClick={() => fileInputRef.current?.click()}>
              {uploading ? <Loader2 className="spin" size={16} /> : <ImagePlus size={16} />}
              上传图片
            </button>
            <input ref={fileInputRef} className="hidden-file" type="file" accept="image/*" multiple onChange={(e) => { uploadFiles(e.target.files); e.currentTarget.value = '' }} />
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className={`gallery-masonry ${galleryItems.length === 0 ? 'is-empty' : ''}`}>
          {galleryItems.length === 0 && <p className="empty-note">画廊里还没有图片</p>}
          {galleryItems.map((item) => (
            <div key={item.id} className="asset-tile gallery-tile" title={item.title}>
              <img src={item.url} alt={item.title} loading="lazy" />
              <span className="asset-provider-badge">{item.provider}</span>
              {item.kind === 'asset' && <button className="asset-use" type="button" onClick={() => useAsset(item.asset)} title="使用">使用</button>}
              {item.kind === 'asset' && <button className="asset-delete" type="button" onClick={() => deleteAsset(item.asset)} title="删除"><X size={14} /></button>}
              <button className="asset-preview-hit" type="button" onClick={() => setPreview(item.url)} title="预览" />
            </div>
          ))}
        </div>
      </div>
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function SettingsPage() {
  const user = useAppStore((s) => s.user)
  const setUser = useAppStore((s) => s.setUser)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const locale = useAppStore((s) => s.locale)
  const setLocale = useAppStore((s) => s.setLocale)
  const [tab, setTab] = useState<'profile' | 'security' | 'billing'>('profile')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [data, setData] = useState<UsageResponse | null>(null)
  const [profileDraft, setProfileDraft] = useState({ display_name: '' })
  const [emailDraft, setEmailDraft] = useState('')
  const [passwordDraft, setPasswordDraft] = useState({ current: '', next: '', confirm: '' })
  const [profileSaving, setProfileSaving] = useState(false)
  const [emailSaving, setEmailSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!user) return
    setProfileDraft({ display_name: user.display_name || '' })
    setEmailDraft(user.email || '')
  }, [user?.display_name, user?.email])

  useEffect(() => {
    api.usage().then(setData).catch((e) => setError(e.message))
  }, [])

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    setProfileSaving(true); setError(''); setNotice('')
    try {
      const res = await api.updateMe({ display_name: profileDraft.display_name })
      setUser(res.user); setNotice('资料已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally { setProfileSaving(false) }
  }

  async function saveEmail(event: FormEvent) {
    event.preventDefault()
    setEmailSaving(true); setError(''); setNotice('')
    try {
      const res = await api.updateMe({ email: emailDraft })
      setUser(res.user); setNotice('邮箱已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally { setEmailSaving(false) }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault()
    if (passwordDraft.next !== passwordDraft.confirm) { setError('两次密码不一致'); return }
    setPasswordSaving(true); setError(''); setNotice('')
    try {
      await api.updatePassword({ current_password: passwordDraft.current, new_password: passwordDraft.next })
      setPasswordDraft({ current: '', next: '', confirm: '' }); setNotice('密码已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失败')
    } finally { setPasswordSaving(false) }
  }

  async function uploadAvatar(file: File | undefined) {
    if (!file) return
    setAvatarUploading(true); setError(''); setNotice('')
    try {
      const res = await api.uploadAvatar(file)
      setUser(res.user); setNotice('头像已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally { setAvatarUploading(false) }
  }

  return (
    <div className="page-shell page-shell-settings page-shell-centered-header">
      <div className="page-header">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">管理你的账户和偏好</p>
      </div>
      {error && <p className="form-error settings-alert">{error}</p>}
      {notice && <p className="form-success settings-alert">{notice}</p>}
      <div className="settings-layout">
        <nav className="settings-nav">
          <button type="button" className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}><UserRound size={16} /><span>账户</span></button>
          <button type="button" className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}><Lock size={16} /><span>安全</span></button>
          <button type="button" className={tab === 'billing' ? 'active' : ''} onClick={() => setTab('billing')}><CreditCard size={16} /><span>账单</span></button>
        </nav>
        <div className="settings-content">
          {tab === 'profile' && (
            <>
              <section className="profile-hero">
                <button type="button" className="avatar-uploader" onClick={() => avatarInputRef.current?.click()} title="上传头像">
                  <UserAvatar user={user} size="large" />
                  <span>{avatarUploading ? <Loader2 className="spin" size={14} /> : <Camera size={14} />}</span>
                </button>
                <input ref={avatarInputRef} className="hidden-file" type="file" accept="image/*" onChange={(e) => { uploadAvatar(e.target.files?.[0]); e.currentTarget.value = '' }} />
                <div>
                  <h3>{userDisplayName(user)}</h3>
                  <p>{user?.role === 'admin' ? '管理员' : '创作者'}</p>
                </div>
              </section>
              <form className="profile-form" onSubmit={saveProfile}>
                <label><span><UserRound size={14} /> 昵称</span><input value={profileDraft.display_name} onChange={(e) => setProfileDraft((d) => ({ ...d, display_name: e.target.value }))} placeholder="展示名称" /></label>
                <button className="primary-button" disabled={profileSaving}>{profileSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />} 保存</button>
              </form>
              <div className="panel-block">
                <h3>偏好</h3>
                <label className="switch-row">
                  <span>{theme === 'dark' ? '夜间模式' : '日间模式'}</span>
                  <button type="button" className="icon-button" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
                </label>
                <label className="switch-row">
                  <span>语言</span>
                  <button type="button" className="icon-button" onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}><Languages size={16} /></button>
                </label>
              </div>
            </>
          )}
          {tab === 'security' && (
            <>
              <div className="panel-block">
                <h3>邮箱</h3>
                <form className="security-inline-form" onSubmit={saveEmail}>
                  <label><span><Mail size={14} /> 登录邮箱</span><input type="email" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} /></label>
                  <button className="secondary-button" disabled={emailSaving}>{emailSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />} 更新邮箱</button>
                </form>
              </div>
              <div className="panel-block">
                <h3>修改密码</h3>
                <form className="security-inline-form" onSubmit={savePassword}>
                  <label><span><KeyRound size={14} /> 当前密码</span><input type="password" value={passwordDraft.current} onChange={(e) => setPasswordDraft((d) => ({ ...d, current: e.target.value }))} /></label>
                  <label><span><Lock size={14} /> 新密码</span><input type="password" minLength={8} value={passwordDraft.next} onChange={(e) => setPasswordDraft((d) => ({ ...d, next: e.target.value }))} /></label>
                  <label><span><KeyRound size={14} /> 确认新密码</span><input type="password" minLength={8} value={passwordDraft.confirm} onChange={(e) => setPasswordDraft((d) => ({ ...d, confirm: e.target.value }))} /></label>
                  <button className="secondary-button" disabled={passwordSaving}>{passwordSaving ? <Loader2 className="spin" size={16} /> : <Check size={16} />} 修改密码</button>
                </form>
              </div>
            </>
          )}
          {tab === 'billing' && data && (
            <>
              <div className="metric-grid">
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function AdminPage() {
  const [tab, setTab] = useState<'overview' | 'users' | 'ledger' | 'settings'>('overview')
  const [statsGranularity, setStatsGranularity] = useState<'hour' | 'day'>('hour')
  const [users, setUsers] = useState<User[]>([])
  const [delta, setDelta] = useState<Record<number, string>>({})
  const [error, setError] = useState('')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [ledger, setLedger] = useState<{ id: number; user_id: number; user_email: string; delta: number; balance: number; reason: string; ref_id: string; created_at: string }[]>([])
  const [settings, setSettings] = useState<RuntimeSettings | null>(null)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const locale = useAppStore((s) => s.locale)

  async function loadUsers() {
    const res = await api.adminUsers()
    setUsers(res.users ?? [])
  }

  async function loadStats(granularity = statsGranularity) {
    const res = await api.adminStats(granularity, granularity === 'hour' ? 24 : 30)
    setStats(res)
  }

  async function loadLedger() {
    const res = await api.adminLedger(200)
    setLedger(res.entries ?? [])
  }

  async function loadSettings() {
    const res = await api.adminSettings()
    setSettings(res.settings)
  }

  async function saveSettings(next: RuntimeSettings) {
    setError('')
    setSettingsSaved(false)
    try {
      const res = await api.adminSaveSettings(next)
      setSettings(res.settings)
      setSettingsSaved(true)
      await loadStats(statsGranularity)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    }
  }

  async function adjust(user: User) {
    const value = Number(delta[user.id])
    if (!Number.isFinite(value) || value === 0) return
    setError('')
    try {
      const res = await api.adminAdjustCredits(user.id, { delta: value, reason: 'admin_adjustment' })
      setUsers((items) => items.map((i) => (i.id === user.id ? res.user : i)))
      setDelta((c) => ({ ...c, [user.id]: '' }))
      await Promise.all([loadStats(), loadLedger()])
    } catch (err) {
      setError(err instanceof Error ? err.message : '调整失败')
    }
  }

  useEffect(() => {
    loadUsers().catch((e) => setError(e.message))
    loadLedger().catch((e) => setError(e.message))
    loadSettings().catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    loadStats(statsGranularity).catch((e) => setError(e.message))
  }, [statsGranularity])

  const usageBuckets = stats?.usage_buckets ?? []
  const maxCredits = Math.max(...usageBuckets.map((d) => d.credits), 1)

  return (
    <div className="page-shell page-shell-wide">
      <div className="page-header">
        <h1 className="page-title">管理</h1>
        <p className="page-subtitle">系统概览、用户管理和日志</p>
      </div>
      <div className="admin-page">
        <nav className="admin-tabs">
          <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><BarChart3 size={16} /><span>概览</span></button>
          <button type="button" className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><Users size={16} /><span>用户</span></button>
          <button type="button" className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}><ScrollText size={16} /><span>日志</span></button>
          <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings2 size={16} /><span>系统设置</span></button>
        </nav>
        {error && <p className="form-error">{error}</p>}
        {settingsSaved && <p className="form-success">设置已保存</p>}
        {tab === 'overview' && stats && (
          <>
            <div className="metric-grid">
              <Metric label="用户" value={stats.total_users} />
              <Metric label="会话" value={stats.total_sessions} />
              <Metric label="任务" value={stats.total_tasks} />
              <Metric label="消耗点数" value={stats.total_credits_spent} />
            </div>
            <br></br>
            <section className="panel-block">
              <div className="panel-head">
                <h3>{statsGranularity === 'hour' ? '近 24 小时消耗' : '近 30 天有消耗的日期'}</h3>
                <div className="segmented-control" role="group" aria-label="统计维度">
                  <button type="button" className={statsGranularity === 'hour' ? 'active' : ''} onClick={() => setStatsGranularity('hour')}>小时</button>
                  <button type="button" className={statsGranularity === 'day' ? 'active' : ''} onClick={() => setStatsGranularity('day')}>天</button>
                </div>
              </div>
              <div className="chart-legend">
                <span><i className="legend-image" />图片生成</span>
                <span><i className="legend-text" />文本模型</span>
              </div>
              <div className="usage-chart">
                {usageBuckets.map((d) => (
                  <UsageBar key={d.period} bucket={d} maxCredits={maxCredits} granularity={statsGranularity} />
                ))}
              </div>
            </section>
          </>
        )}

        {tab === 'users' && (
          <div className="admin-list">
            {users.map((item) => (
              <div className="admin-row" key={item.id}>
                <div><strong>{item.display_name}</strong><span>{item.email}</span></div>
                <code>{translate(locale, `role.${item.role}`, item.role)}</code>
                <b>{item.credits}</b>
                <input value={delta[item.id] ?? ''} onChange={(e) => setDelta((c) => ({ ...c, [item.id]: e.target.value }))} placeholder="+10 / -5" />
                <button className="secondary-button" onClick={() => adjust(item)}>调整</button>
              </div>
            ))}
          </div>
        )}

        {tab === 'ledger' && (
          <div className="ledger-list admin-ledger">
            {ledger.map((item) => (
              <div key={item.id}>
                <span className="ledger-email">{item.user_email}</span>
                <span>{localizeReason(locale, item.reason)}</span>
                <strong className={item.delta > 0 ? 'positive' : 'negative'}>{item.delta > 0 ? `+${item.delta}` : item.delta}</strong>
                <small>{new Date(item.created_at).toLocaleString()}</small>
              </div>
            ))}
            {ledger.length === 0 && <p className="empty-note">暂无日志</p>}
          </div>
        )}

        {tab === 'settings' && settings && (
          <AdminSystemSettings settings={settings} onChange={setSettings} onSave={saveSettings} />
        )}
      </div>
    </div>
  )
}

function AdminSystemSettings({ settings, onChange, onSave }: { settings: RuntimeSettings; onChange: (settings: RuntimeSettings) => void; onSave: (settings: RuntimeSettings) => void }) {
  const [section, setSection] = useState<'basic' | 'models' | 'llm' | 'upload' | 'billing' | 'image'>('basic')
  const [modelOptions, setModelOptions] = useState<Record<string, RuntimeLLMModel[]>>({})
  const [modelLoading, setModelLoading] = useState<Record<string, boolean>>({})
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({})
  const patch = (next: Partial<RuntimeSettings>) => onChange({ ...settings, ...next })
  const patchDefaults = (next: Partial<RuntimeSettings['defaults']>) => patch({ defaults: { ...settings.defaults, ...next } })
  const patchBilling = (next: Partial<RuntimeSettings['billing']>) => patch({ billing: { ...settings.billing, ...next } })
  const patchLLM = (index: number, next: Partial<RuntimeSettings['llm_providers'][number]>) => {
    if ('id' in next || 'type' in next || 'base_url' in next || 'api_key' in next) {
      clearModelCache(index)
    }
    patch({ llm_providers: settings.llm_providers.map((item, i) => (i === index ? { ...item, ...next } : item)) })
  }
  const patchUpload = (index: number, next: Partial<RuntimeSettings['upload_providers'][number]>) =>
    patch({ upload_providers: settings.upload_providers.map((item, i) => (i === index ? { ...item, ...next } : item)) })
  const patchImage = (index: number, next: Partial<RuntimeSettings['image_providers'][number]>) =>
    patch({ image_providers: settings.image_providers.map((item, i) => (i === index ? { ...item, ...next } : item)) })
  const numberValue = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0
  const providerListKey = (index: number) => `llm-models-${index}`
  const providerListId = (index: number) => `${providerListKey(index)}-list`

  function clearModelCache(index: number) {
    const key = providerListKey(index)
    setModelOptions((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setModelLoading((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setModelErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  async function loadModels(index: number, force = false) {
    const provider = settings.llm_providers[index]
    if (!provider || provider.type !== 'openai_compatible' || !provider.base_url.trim()) return
    const key = providerListKey(index)
    if (!force && modelOptions[key]) return
    setModelLoading((current) => ({ ...current, [key]: true }))
    setModelErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    try {
      const res = await api.adminLLMProviderModels(provider)
      setModelOptions((current) => ({ ...current, [key]: res.models ?? [] }))
    } catch (err) {
      setModelErrors((current) => ({ ...current, [key]: err instanceof Error ? err.message : '模型列表加载失败' }))
    } finally {
      setModelLoading((current) => ({ ...current, [key]: false }))
    }
  }

  const defaultPlannerIndex = settings.llm_providers.findIndex((p) => p.id === settings.defaults.planner_provider)
  const defaultTitleIndex = settings.llm_providers.findIndex((p) => p.id === settings.defaults.title_provider)
  const defaultPlannerListId = defaultPlannerIndex >= 0 ? providerListId(defaultPlannerIndex) : ''
  const defaultTitleListId = defaultTitleIndex >= 0 ? providerListId(defaultTitleIndex) : ''

  return (
    <div className="settings-layout admin-settings-layout">
      <nav className="settings-nav">
        <button type="button" className={section === 'basic' ? 'active' : ''} onClick={() => setSection('basic')}><Settings2 size={16} /><span>基础设置</span></button>
        <button type="button" className={section === 'models' ? 'active' : ''} onClick={() => setSection('models')}><Sparkles size={16} /><span>模型管理</span></button>
        <button type="button" className={section === 'llm' ? 'active' : ''} onClick={() => setSection('llm')}><Sparkles size={16} /><span>LLM providers</span></button>
        <button type="button" className={section === 'upload' ? 'active' : ''} onClick={() => setSection('upload')}><ImagePlus size={16} /><span>上传 / 图床</span></button>
        <button type="button" className={section === 'image' ? 'active' : ''} onClick={() => setSection('image')}><Camera size={16} /><span>图片 provider</span></button>
        <button type="button" className={section === 'billing' ? 'active' : ''} onClick={() => setSection('billing')}><CreditCard size={16} /><span>计费规则</span></button>
      </nav>
      <div className="settings-content">
        {section === 'basic' && (
          <section className="panel-block system-settings-grid">
            <h3>默认选择</h3>
            <label><span>默认 planner provider</span><select value={settings.defaults.planner_provider} onChange={(e) => patchDefaults({ planner_provider: e.target.value })}>{settings.llm_providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
            <label><span>默认 planner model</span><input list={defaultPlannerListId || undefined} value={settings.defaults.planner_model} onFocus={() => defaultPlannerIndex >= 0 && loadModels(defaultPlannerIndex)} onChange={(e) => patchDefaults({ planner_model: e.target.value })} /></label>
            <label><span>标题 provider</span><select value={settings.defaults.title_provider} onChange={(e) => patchDefaults({ title_provider: e.target.value })}>{settings.llm_providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
            <label><span>标题 model</span><input list={defaultTitleListId || undefined} value={settings.defaults.title_model} onFocus={() => defaultTitleIndex >= 0 && loadModels(defaultTitleIndex)} onChange={(e) => patchDefaults({ title_model: e.target.value })} /></label>
            <label><span>默认上传 provider</span><select value={settings.defaults.upload_provider} onChange={(e) => patchDefaults({ upload_provider: e.target.value })}>{settings.upload_providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
            <label><span>默认图片 provider</span><select value={settings.defaults.image_provider} onChange={(e) => patchDefaults({ image_provider: e.target.value })}>{settings.image_providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
          </section>
        )}
        {section === 'models' && (
          <section className="panel-block provider-list">
            <h3>模型管理</h3>
            {settings.llm_providers.map((p, i) => (
              <div className="provider-editor" key={`model-${p.id}-${i}`}>
                <label><span>名称</span><input value={p.name} onChange={(e) => patchLLM(i, { name: e.target.value })} /></label>
                <label><span>Planner model</span><input list={providerListId(i)} value={p.planner_model} onFocus={() => loadModels(i)} onChange={(e) => patchLLM(i, { planner_model: e.target.value })} /></label>
                <label><span>Title model</span><input list={providerListId(i)} value={p.title_model} onFocus={() => loadModels(i)} onChange={(e) => patchLLM(i, { title_model: e.target.value })} /></label>
                <label><span>Multiplier</span><input type="number" step="0.01" value={p.credit_multiplier} onChange={(e) => patchLLM(i, { credit_multiplier: numberValue(e.target.value) })} /></label>
                <label className="toggle-row"><input type="checkbox" checked={p.allow_user_select} onChange={(e) => patchLLM(i, { allow_user_select: e.target.checked })} /><span>允许用户选择</span></label>
                <label className="toggle-row"><input type="checkbox" checked={p.supports_vision} onChange={(e) => patchLLM(i, { supports_vision: e.target.checked })} /><span>支持图像输入</span></label>
                <label className="toggle-row"><input type="checkbox" checked={p.enabled} onChange={(e) => patchLLM(i, { enabled: e.target.checked })} /><span>启用</span></label>
                {modelLoading[providerListKey(i)] && <p className="empty-note">正在加载模型列表...</p>}
                {modelErrors[providerListKey(i)] && <p className="form-error">{modelErrors[providerListKey(i)]}</p>}
              </div>
            ))}
          </section>
        )}
        {section === 'llm' && (
          <section className="panel-block provider-list">
            <div className="panel-head"><h3>LLM providers</h3><div className="panel-actions"><button type="button" className="secondary-button" onClick={() => patch({ llm_providers: [...settings.llm_providers, { id: `llm-${settings.llm_providers.length + 1}`, name: 'New LLM', type: 'openai_compatible', base_url: '', api_key: '', planner_model: '', title_model: '', timeout_seconds: 45, max_context_messages: 12, credit_multiplier: 1, supports_vision: false, allow_user_select: true, enabled: true }] })}><Plus size={16} />新增</button></div></div>
            {settings.llm_providers.map((p, i) => (
              <div className="provider-editor" key={`${p.id}-${i}`}>
                <label><span>ID</span><input value={p.id} onChange={(e) => patchLLM(i, { id: e.target.value })} /></label>
                <label><span>名称</span><input value={p.name} onChange={(e) => patchLLM(i, { name: e.target.value })} /></label>
                <label><span>类型</span><select value={p.type} onChange={(e) => patchLLM(i, { type: e.target.value })}><option value="builtin">builtin</option><option value="openai_compatible">openai_compatible</option></select></label>
                <label><span>Base URL</span><input value={p.base_url} onChange={(e) => patchLLM(i, { base_url: e.target.value })} /></label>
                <label><span>API Key</span><input value={p.api_key} onChange={(e) => patchLLM(i, { api_key: e.target.value })} /></label>
                <label><span>Planner model</span><input list={providerListId(i)} value={p.planner_model} onFocus={() => loadModels(i)} onChange={(e) => patchLLM(i, { planner_model: e.target.value })} /></label>
                <label><span>Title model</span><input list={providerListId(i)} value={p.title_model} onFocus={() => loadModels(i)} onChange={(e) => patchLLM(i, { title_model: e.target.value })} /></label>
                <label><span>Multiplier</span><input type="number" step="0.01" value={p.credit_multiplier} onChange={(e) => patchLLM(i, { credit_multiplier: numberValue(e.target.value) })} /></label>
                <label className="toggle-row"><input type="checkbox" checked={p.allow_user_select} onChange={(e) => patchLLM(i, { allow_user_select: e.target.checked })} /><span>允许用户选择</span></label>
                <label className="toggle-row"><input type="checkbox" checked={p.supports_vision} onChange={(e) => patchLLM(i, { supports_vision: e.target.checked })} /><span>支持图像输入</span></label>
                <label className="toggle-row"><input type="checkbox" checked={p.enabled} onChange={(e) => patchLLM(i, { enabled: e.target.checked })} /><span>启用</span></label>
                {modelLoading[providerListKey(i)] && <p className="empty-note">正在加载模型列表...</p>}
                {modelErrors[providerListKey(i)] && <p className="form-error">{modelErrors[providerListKey(i)]}</p>}
              </div>
            ))}
          </section>
        )}
        <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
          {settings.llm_providers.map((provider, index) => (
            <datalist key={provider.id || index} id={providerListId(index)}>
              {(modelOptions[providerListKey(index)] ?? []).map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </datalist>
          ))}
        </div>
        {section === 'upload' && (
          <section className="panel-block provider-list">
            <div className="panel-head"><h3>上传 / 图床 providers</h3><button type="button" className="secondary-button" onClick={() => patch({ upload_providers: [...settings.upload_providers, { id: `upload-${settings.upload_providers.length + 1}`, name: 'New Upload', type: 'lsky', base_url: '', token: '', strategy_id: 0, enabled: true }] })}><Plus size={16} />新增</button></div>
            {settings.upload_providers.map((p, i) => (
              <div className="provider-editor" key={`${p.id}-${i}`}>
                <label><span>ID</span><input value={p.id} onChange={(e) => patchUpload(i, { id: e.target.value })} /></label>
                <label><span>名称</span><input value={p.name} onChange={(e) => patchUpload(i, { name: e.target.value })} /></label>
                <label><span>类型</span><select value={p.type} onChange={(e) => patchUpload(i, { type: e.target.value })}><option value="evolink">evolink</option><option value="lsky">lsky</option></select></label>
                <label><span>Base URL</span><input value={p.base_url} onChange={(e) => patchUpload(i, { base_url: e.target.value })} /></label>
                <label><span>Token</span><input value={p.token} onChange={(e) => patchUpload(i, { token: e.target.value })} /></label>
                <label><span>Strategy ID</span><input type="number" value={p.strategy_id} onChange={(e) => patchUpload(i, { strategy_id: Math.trunc(numberValue(e.target.value)) })} /></label>
                <label className="toggle-row"><input type="checkbox" checked={p.enabled} onChange={(e) => patchUpload(i, { enabled: e.target.checked })} /><span>启用</span></label>
              </div>
            ))}
          </section>
        )}
        {section === 'image' && (
          <section className="panel-block provider-list">
            <h3>图片 provider</h3>
            {settings.image_providers.map((p, i) => (
              <div className="provider-editor" key={`${p.id}-${i}`}>
                <label><span>ID</span><input value={p.id} onChange={(e) => patchImage(i, { id: e.target.value })} /></label>
                <label><span>名称</span><input value={p.name} onChange={(e) => patchImage(i, { name: e.target.value })} /></label>
                <label><span>类型</span><select value={p.type} onChange={(e) => patchImage(i, { type: e.target.value })}><option value="evolink">evolink</option><option value="right_codes">right_codes</option></select></label>
                <label><span>Model</span><input value={p.model} onChange={(e) => patchImage(i, { model: e.target.value })} /></label>
                <label><span>Base URL</span><input value={p.base_url} onChange={(e) => patchImage(i, { base_url: e.target.value })} /></label>
                <label><span>Files Base URL</span><input value={p.files_base_url} onChange={(e) => patchImage(i, { files_base_url: e.target.value })} /></label>
                <label><span>API Key</span><input value={p.api_key} onChange={(e) => patchImage(i, { api_key: e.target.value })} /></label>
                <label><span>Multiplier</span><input type="number" step="0.01" value={p.credit_multiplier} onChange={(e) => patchImage(i, { credit_multiplier: numberValue(e.target.value) })} /></label>
                <label className="toggle-row"><input type="checkbox" checked={p.allow_user_select} onChange={(e) => patchImage(i, { allow_user_select: e.target.checked })} /><span>允许用户选择</span></label>
                <label className="toggle-row"><input type="checkbox" checked={p.enabled} onChange={(e) => patchImage(i, { enabled: e.target.checked })} /><span>启用</span></label>
              </div>
            ))}
          </section>
        )}
        {section === 'billing' && (
          <section className="panel-block system-settings-grid">
            <h3>计费规则</h3>
            <label><span>新用户赠送</span><input type="number" value={settings.billing.signup_credits} onChange={(e) => patchBilling({ signup_credits: Math.trunc(numberValue(e.target.value)) })} /></label>
            <label><span>LLM 基础点数</span><input type="number" value={settings.billing.llm_base_cost} onChange={(e) => patchBilling({ llm_base_cost: Math.trunc(numberValue(e.target.value)) })} /></label>
            <label><span>图片基础点数</span><input type="number" value={settings.billing.image_base_cost} onChange={(e) => patchBilling({ image_base_cost: Math.trunc(numberValue(e.target.value)) })} /></label>
            <label><span>参考图点数</span><input type="number" value={settings.billing.image_input_cost} onChange={(e) => patchBilling({ image_input_cost: Math.trunc(numberValue(e.target.value)) })} /></label>
            <label><span>高质量 multiplier</span><input type="number" step="0.01" value={settings.billing.high_quality_multiplier} onChange={(e) => patchBilling({ high_quality_multiplier: numberValue(e.target.value) })} /></label>
            <label><span>低质量 multiplier</span><input type="number" step="0.01" value={settings.billing.low_quality_multiplier} onChange={(e) => patchBilling({ low_quality_multiplier: numberValue(e.target.value) })} /></label>
          </section>
        )}
        <div className="settings-actions">
          <button type="button" className="primary-button" onClick={() => onSave(settings)}><Check size={16} />保存设置</button>
        </div>
      </div>
    </div>
  )
}

// ── Utilities ──

function withReferenceMarkdown(text: string, assets: Asset[]) {
  if (assets.length === 0) return text
  const refs = assets.map((a, i) => `![图${i + 1}](${assetImageSrc(a)})`).join(' ')
  return `${text}\n\n${refs}`
}

function splitReferenceMarkdown(text: string) {
  const refs: { alt: string; url: string }[] = []
  const cleaned = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) => { refs.push({ alt, url }); return '' })
    .replace(/\n{3,}/g, '\n\n').trim()
  return { text: cleaned || text, refs }
}

function userDisplayName(user: User | null) {
  return user?.display_name?.trim() || user?.email?.split('@')[0] || 'PicTu 用户'
}

function initialsFor(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return 'P'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length > 1) return parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase()
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase()
}

function buildComposerGreeting(user: User | null) {
  const name = userDisplayName(user)
  const hour = new Date().getHours()
  const rand = Math.random()

  const playful = [
    `${name}，今天让画面先呼吸一下`,
    `给 ${name} 留一盏灵感的小灯`,
    `${name}，来一张会被记住的图`,
    `今天的第一笔，交给 ${name}`,
    `${name}，脑海里的画面该落地了`,
    `${name}，想好画什么了吗？`,
    `${name}，把想象变成像素吧`,
    `${name}，今天想创造点什么？`,
    `落笔之前，先深呼吸，${name}`,
    `${name}，灵感来了别让它跑了`,
  ]

  if (rand < 0.15) return playful[Math.floor(Math.random() * playful.length)]

  const showExtra = new Date().getMinutes() % 2 === 1

  if (hour < 5) return `夜深了，${name}` + (showExtra ? `，适合画安静的东西` : ``)
  if (hour < 9) return `早安，${name}` + (showExtra ? `，新的一天从一张图开始` : ``)
  if (hour < 12) return `上午好，${name}` + (showExtra ? `，光线正好，适合创作` : ``)
  if (hour < 14) return `中午好，${name}` + (showExtra ? `，午后来点灵感？` : ``)
  if (hour < 18) return `下午好，${name}` + (showExtra ? `，继续画吧` : ``)
  if (hour < 22) return `晚上好，${name}` + (showExtra ? `，夜晚总能出好图` : ``)
  return `夜深了，${name}` + (showExtra ? `，熬夜创作要记得休息` : ``)
}

function hashString(value: string) {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

function uniqueAssets(assets: Asset[]) {
  const seen = new Set<string>()
  return assets.filter((a) => {
    const provider = a.provider || 'default'
    const key = a.content_hash ? `${provider}:hash:${a.content_hash}` : a.url ? `${provider}:url:${a.url}` : `asset:${a.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function galleryItemsFromUsage(data: UsageResponse | null): GalleryItem[] {
  const generatedFromTasks: GalleryItem[] = (data?.tasks ?? []).flatMap((task) =>
    extractImages(task).map((url, index) => ({
      id: `task-${task.id}-${index}`,
      kind: 'task' as const,
      task,
      url,
      title: task.prompt || `生成图 ${task.id}`,
      provider: providerName(task.provider || 'generated'),
      created_at: task.created_at,
      generated: true as const,
    })),
  )
  const assetItems: GalleryItem[] = uniqueAssets(data?.assets ?? []).map((asset) => ({
    id: `asset-${asset.id}`,
    kind: 'asset' as const,
    asset,
    url: assetImageSrc(asset),
    title: asset.file_name,
    provider: providerLabel(asset),
    created_at: asset.created_at,
    generated: isGeneratedAsset(asset),
  }))
  return [...generatedFromTasks, ...assetItems].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

const defaultRemoveBackgroundPrompt = 'Remove the background from the selected image. Keep the subject unchanged, preserve edges and fine details, and output a transparent PNG.'

function emptyCanvasState(): CanvasState {
  return { zoom: 1, panX: 60, panY: 60, nodes: [] }
}

function parseCanvasState(raw?: string): CanvasState {
  if (!raw) return emptyCanvasState()
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasState>
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter(isCanvasNode) : []
    return {
      zoom: clampNumber(parsed.zoom, 0.2, 3, 1),
      panX: typeof parsed.panX === 'number' ? parsed.panX : 60,
      panY: typeof parsed.panY === 'number' ? parsed.panY : 60,
      nodes,
    }
  } catch {
    return emptyCanvasState()
  }
}

function isCanvasNode(value: unknown): value is CanvasNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<CanvasNode>
  return typeof node.id === 'string'
    && typeof node.url === 'string'
    && typeof node.title === 'string'
    && typeof node.x === 'number'
    && typeof node.y === 'number'
    && typeof node.w === 'number'
    && typeof node.h === 'number'
}

function mergeCanvasState(state: CanvasState, sources: CanvasNode[]): CanvasState {
  const byID = new Map(state.nodes.map((node) => [node.id, node]))
  const localNodes = state.nodes.filter((node) => node.source === 'local')
  const merged = sources.map((node) => ({ ...node, ...byID.get(node.id), url: node.url, title: byID.get(node.id)?.title || node.title }))
  return { ...state, nodes: [...localNodes, ...merged] }
}

function canvasNodesFromDetail(detail: SessionDetail | null): CanvasNode[] {
  if (!detail) return []
  const taskNodes = (detail.tasks ?? []).flatMap((task, taskIndex) =>
    extractImages(task).map((url, imageIndex) => ({
      id: `task-${task.id}-${imageIndex}`,
      source: 'task' as const,
      task_id: task.id,
      image_index: imageIndex,
      url,
      title: `生成图 ${taskIndex + 1}.${imageIndex + 1}`,
      prompt: task.prompt,
      x: 260 * (imageIndex % 3),
      y: 260 * taskIndex,
      w: 240,
      h: 240,
    })),
  )
  const assetNodes = uniqueAssets(detail.assets ?? []).map((asset, index) => nodeFromAsset(asset, taskNodes.length + index))
  return [...taskNodes, ...assetNodes]
}

function nodeFromAsset(asset: Asset, index: number): CanvasNode {
  return {
    id: `asset-${asset.id}`,
    source: 'asset',
    asset_id: asset.id,
    url: assetImageSrc(asset),
    title: asset.file_name || `图片 ${asset.id}`,
    x: 260 * (index % 3),
    y: 260 * Math.floor(index / 3),
    w: 240,
    h: 240,
  }
}

function upsertCanvasNode(nodes: CanvasNode[], node: CanvasNode) {
  if (nodes.some((item) => item.id === node.id)) return nodes.map((item) => (item.id === node.id ? { ...item, ...node } : item))
  return [node, ...nodes]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

function removeBackgroundFromURL(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight))
      const width = Math.max(1, Math.round(img.naturalWidth * scale))
      const height = Math.max(1, Math.round(img.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('浏览器不支持 Canvas'))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      const data = ctx.getImageData(0, 0, width, height)
      const bg = sampleEdgeColor(data.data, width, height)
      for (let i = 0; i < data.data.length; i += 4) {
        const distance = colorDistance(data.data[i], data.data[i + 1], data.data[i + 2], bg)
        if (distance < 34) data.data[i + 3] = 0
        else if (distance < 62) data.data[i + 3] = Math.round(data.data[i + 3] * ((distance - 34) / 28))
      }
      ctx.putImageData(data, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })
}

function sampleEdgeColor(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]
  const sum = points.reduce<[number, number, number]>((acc, [x, y]) => {
    const i = (y * width + x) * 4
    return [acc[0] + data[i], acc[1] + data[i + 1], acc[2] + data[i + 2]]
  }, [0, 0, 0])
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length]
}

function colorDistance(r: number, g: number, b: number, bg: [number, number, number]) {
  return Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
}

function assetImageSrc(asset: Asset) { return asset.local_url || asset.url }

function isGeneratedAsset(asset: Asset) {
  const provider = (asset.provider || '').toLowerCase()
  return provider === 'generated' || provider === 'generation' || provider === 'task'
}

function providerLabel(asset: Asset) {
  if (!asset.provider) return '未知渠道'
  if (asset.provider === 'evolink') return 'Evolink'
  if (asset.provider === 'maxqi') return 'MaxQi'
  return asset.provider
}

function providerName(provider: string) {
  if (!provider) return '生成'
  if (provider === 'evolink') return 'Evolink'
  if (provider === 'maxqi') return 'MaxQi'
  return provider
}

function extractImages(task?: Task): string[] {
  if (!task?.result_json) return []
  try {
    const parsed = JSON.parse(task.result_json)
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { pictu_local_urls?: unknown }).pictu_local_urls)) {
      return ((parsed as { pictu_local_urls: unknown[] }).pictu_local_urls).filter((i): i is string => typeof i === 'string')
    }
    const urls = new Set<string>()
    const walk = (v: unknown) => {
      if (typeof v === 'string' && /^(https?:\/\/.+|\/generated\/.+)\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(v)) urls.add(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(parsed)
    return Array.from(urls)
  } catch { return [] }
}

function AuthScreen() {
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
