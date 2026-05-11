import { useEffect, useRef, useState } from 'react'
import { Archive, Images, MessageSquarePlus, PanelLeft, PanelRight, Search, Sparkles } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from './lib/api'
import { useAppStore } from './store/appStore'
import type { Message, RuntimeSettings, Session, SessionDetail } from './types/api'
import { CanvasPage } from './pages/CanvasPage'
import { ChatsPage } from './pages/ChatsPage'
import { GalleryPage } from './pages/GalleryPage'
import { SettingsPage } from './pages/SettingsPage'
import { AdminPage } from './pages/AdminPage'
import { Composer, EditableTitle, MessageStream, SessionDot, UserDock } from './components/workspace'
import { NEW_CONVERSATION_DRAFT_PREFIX, type NewConversationDraft, type PendingRequest, type ToolDraft } from './lib/workspace'

export function Workspace() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId)
  const setDraft = useAppStore((s) => s.setDraft)
  const setSelectedAssets = useAppStore((s) => s.setSelectedAssets)
  const setSettings = useAppStore((s) => s.setSettings)
  const setUsePlanner = useAppStore((s) => s.setUsePlanner)
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
    const publicID = detail?.session.public_id
    if (!isChatRoute || !publicID) return
    const key = `${NEW_CONVERSATION_DRAFT_PREFIX}${publicID}`
    const raw = window.localStorage.getItem(key)
    if (!raw) return
    window.localStorage.removeItem(key)
    try {
      const next = JSON.parse(raw) as Partial<NewConversationDraft>
      if (!next.createdAt || Date.now() - next.createdAt > 10 * 60 * 1000) return
      if (typeof next.draft === 'string') setDraft(next.draft)
      if (next.settings) setSettings(next.settings)
      if (Array.isArray(next.assetIds)) setSelectedAssets(next.assetIds)
      if (typeof next.usePlanner === 'boolean') setUsePlanner(next.usePlanner)
    } catch {
      return
    }
  }, [detail?.session.public_id, isChatRoute, setDraft, setSelectedAssets, setSettings, setUsePlanner])

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
