import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Loader2,
  LogOut,
  MessageSquarePlus,
  Moon,
  Pencil,
  Plus,
  Settings2,
  Shield,
  Send,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import type { Asset, Capsule, GenerationPlan, Message, RuntimeSettings, Session, Task, UsageBucket } from '../types/api'
import { localizeQuality, localizeReason, localizeStatus, translate, type Locale } from '../i18n'
import { useAppStore } from '../store/appStore'
import {
  assetImageSrc,
  assetsInSelectionOrder,
  buildComposerGreeting,
  defaultRemoveBackgroundPrompt,
  extractImages,
  imageRatioFromSize,
  imageSizeFromRatio,
  imageSizeLabel,
  NEW_CONVERSATION_DRAFT_PREFIX,
  parseCommands,
  normalizeGenerationSettings,
  normalizeImageSize,
  IMAGE_RATIO_PRESETS,
  IMAGE_RESOLUTION_PRESETS,
  splitReferenceMarkdown,
  type GenerationSettingsValue,
  type NewConversationDraft,
  type PendingRequest,
  type ToolDraft,
  uniqueAssets,
  withReferenceMarkdown,
} from '../lib/workspace'

export function SessionDot({ session, hasRequest, completedNotice }: { session: Session; hasRequest: boolean; completedNotice?: boolean }) {
  let cls = ''
  if (hasRequest) cls = 'request'
  else if (session.task_status === 'pending' || session.task_status === 'processing') cls = 'working'
  else if (session.task_status === 'completed' && completedNotice === true) cls = 'done'
  if (!cls) return <span className="session-dot empty" />
  return <span className={`session-dot ${cls}`} />
}

export function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => Promise<void> }) {
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

export function UserAvatar({ user, size = 'regular' }: { user: { display_name?: string | null; email?: string | null; avatar_url?: string | null } | null; size?: 'small' | 'regular' | 'large' }) {
  const name = userDisplayName(user)
  return (
    <span className={`avatar ${size}`}>
      {user?.avatar_url ? <img src={user.avatar_url} alt={name} /> : <span>{initialsFor(name)}</span>}
    </span>
  )
}

export function UserDock({ user, open, collapsed, onToggleOpen, onClose, onOpenSettings, onOpenAdmin, onLogout }: {
  user: { display_name?: string | null; email?: string | null; avatar_url?: string | null; role?: string | null } | null
  open: boolean
  collapsed: boolean
  onToggleOpen: () => void
  onClose: () => void
  onOpenSettings: () => void
  onOpenAdmin: () => void
  onLogout: () => void
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

export function MessageStream({ messages, tasks, streamingText, thinkingText, toolDraft, locale }: {
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
  }, [messages.length, tasks.length, streamingText, thinkingText, toolDraft?.prompt, toolDraft?.phase, toolDraft?.progress])

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
          <div className="task-meta">
            <span>{translate(locale, `tool.${toolDraft.phase}`)}</span>
            {typeof toolDraft.progress === 'number' ? <strong>{toolDraft.progress}%</strong> : <Loader2 className="spin" size={16} />}
          </div>
          {typeof toolDraft.progress === 'number' && <div className="progress"><span style={{ width: `${Math.max(toolDraft.progress, 8)}%` }} /></div>}
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

export function Composer({ sessionId, assets, onChanged, onEnsureSession, setStreamingText, setThinkingText, setStreamingSessionId, setToolDraft, setOptimisticMessages, pendingRequest, setPendingRequest, conversationStarted, runtimeSettings }: {
  sessionId: number | null
  assets: Asset[]
  conversationStarted: boolean
  onChanged: () => void | Promise<void>
  onEnsureSession: () => Promise<Session | null>
  setStreamingText: Dispatch<SetStateAction<string>>
  setThinkingText: Dispatch<SetStateAction<string>>
  setStreamingSessionId: Dispatch<SetStateAction<number | null>>
  setToolDraft: Dispatch<SetStateAction<ToolDraft | null>>
  setOptimisticMessages: Dispatch<SetStateAction<Record<number, Message[]>>>
  pendingRequest: PendingRequest | null
  setPendingRequest: Dispatch<SetStateAction<PendingRequest | null>>
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
  const plannerProvider = useAppStore((s) => s.plannerProvider)
  const setPlannerProvider = useAppStore((s) => s.setPlannerProvider)
  const imageProvider = useAppStore((s) => s.imageProvider)
  const setImageProvider = useAppStore((s) => s.setImageProvider)
  const usePlanner = useAppStore((s) => s.usePlanner)
  const setUsePlanner = useAppStore((s) => s.setUsePlanner)
  const user = useAppStore((s) => s.user)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assetGalleryOpen, setAssetGalleryOpen] = useState(false)
  const [plannerProviderOpen, setPlannerProviderOpen] = useState(false)
  const [imageProviderOpen, setImageProviderOpen] = useState(false)
  const [countMenuOpen, setCountMenuOpen] = useState(false)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [capsules, setCapsules] = useState<Capsule[]>([])
  const [selectedCapsules, setSelectedCapsules] = useState<Capsule[]>([])
  const [capsuleLookupOpen, setCapsuleLookupOpen] = useState(false)
  const [capsuleLookupQuery, setCapsuleLookupQuery] = useState('')
  const [capsuleLookupStart, setCapsuleLookupStart] = useState(0)
  const [capsuleActiveIndex, setCapsuleActiveIndex] = useState(0)
  const [galleryPreview, setGalleryPreview] = useState<string | null>(null)
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const visibleAssets = useMemo(() => uniqueAssets(assets), [assets])
  const galleryAssets = useMemo(() => uniqueAssets([...visibleAssets, ...libraryAssets]), [visibleAssets, libraryAssets])
  const selectedAssets = useMemo(() => assetsInSelectionOrder(selectedAssetIds, [...assets, ...libraryAssets]), [selectedAssetIds, assets, libraryAssets])
  const capsuleMatches = useMemo(() => {
    const q = capsuleLookupQuery.trim().toLowerCase()
    const selected = new Set(selectedCapsules.map((item) => item.capsule_id))
    return capsules
      .filter((item) => !selected.has(item.capsule_id))
      .filter((item) => !q || [item.capsule_id, item.title, item.type, item.tags.join(' ')].some((value) => value.toLowerCase().includes(q)))
      .slice(0, 8)
  }, [capsules, capsuleLookupQuery, selectedCapsules])
  const composerCentered = !conversationStarted
  const greeting = useMemo(() => buildComposerGreeting(user), [user?.display_name, user?.email])
  const selectedPlannerProvider = plannerProvider || runtimeSettings?.defaults.planner_provider || ''
  const selectedPlannerProviderConfig = runtimeSettings?.llm_providers.find((p) => p.id === selectedPlannerProvider)
  const selectedPlannerModel = selectedPlannerProviderConfig?.planner_model || runtimeSettings?.defaults.planner_model || ''
  const selectedPlannerProviderLabel = selectedPlannerProviderConfig?.name || selectedPlannerProvider
  const selectedImageProvider = imageProvider || runtimeSettings?.defaults.image_provider || ''
  const selectedImageProviderLabel = runtimeSettings?.image_providers.find((p) => p.id === selectedImageProvider)?.name || selectedImageProvider
  const effectiveSettings = useMemo(() => normalizeGenerationSettings(settings), [settings.size, settings.resolution, settings.quality, settings.count])
  const selectedImageSizeLabel = imageSizeLabel(effectiveSettings.size)

  const parsedCommands = useMemo(() => parseCommands(draft), [draft])
  const hasCommandOverrides = Object.keys(parsedCommands.overrides).length > 0

  useEffect(() => {
    if (!runtimeSettings) return
    if (!uploadProvider || !runtimeSettings.upload_providers.some((p) => p.id === uploadProvider)) {
      setUploadProvider(runtimeSettings.defaults.upload_provider)
    }
  }, [runtimeSettings, uploadProvider, setUploadProvider])

  useEffect(() => {
    if (!runtimeSettings) return
    if (plannerProvider && !runtimeSettings.llm_providers.some((p) => p.id === plannerProvider && p.enabled && p.allow_user_select)) {
      setPlannerProvider('')
    }
    if (imageProvider && !runtimeSettings.image_providers.some((p) => p.id === imageProvider && p.enabled && p.allow_user_select)) {
      setImageProvider('')
    }
  }, [runtimeSettings, plannerProvider, imageProvider, setPlannerProvider, setImageProvider])

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

  async function loadCapsules() {
    try {
      const res = await api.listCapsules()
      setCapsules(res.capsules ?? [])
    } catch {
      setCapsules([])
    }
  }

  useEffect(() => {
    loadCapsules()
  }, [])

  function editorText() {
    return editorRef.current?.textContent ?? ''
  }

  function editorCaretOffset() {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return editorText().length
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return editorText().length
    const before = range.cloneRange()
    before.selectNodeContents(editor)
    before.setEnd(range.startContainer, range.startOffset)
    return before.toString().length
  }

  function setEditorText(value: string, caretOffset = value.length) {
    const editor = editorRef.current
    if (!editor) return
    editor.textContent = value
    const textNode = editor.firstChild
    const range = document.createRange()
    const selection = window.getSelection()
    if (!selection) return
    const offset = Math.max(0, Math.min(caretOffset, value.length))
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      range.setStart(textNode, offset)
    } else {
      range.setStart(editor, 0)
    }
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function updateCapsuleLookup(text: string, caretOffset: number) {
    const before = text.slice(0, caretOffset)
    const match = before.match(/(?:^|\s)@([a-zA-Z0-9/_-]*)$/)
    if (!match) {
      setCapsuleLookupOpen(false)
      return
    }
    const query = match[1] ?? ''
    setCapsuleLookupStart(caretOffset - query.length - 1)
    setCapsuleLookupQuery(query)
    setCapsuleActiveIndex(0)
    setCapsuleLookupOpen(true)
  }

  function handleEditorInput() {
    const text = editorText()
    setDraft(text)
    updateCapsuleLookup(text, editorCaretOffset())
  }

  function chooseCapsule(capsule: Capsule) {
    if (selectedCapsules.some((item) => item.capsule_id === capsule.capsule_id)) return
    const text = editorText()
    const caret = editorCaretOffset()
    const nextText = (text.slice(0, capsuleLookupStart) + text.slice(caret)).replace(/[ \t]{2,}/g, ' ')
    setSelectedCapsules((items) => [...items, capsule])
    setDraft(nextText)
    setCapsuleLookupOpen(false)
    window.setTimeout(() => {
      editorRef.current?.focus()
      setEditorText(nextText, capsuleLookupStart)
    }, 0)
  }

  function removeCapsule(capsuleID: string) {
    setSelectedCapsules((items) => items.filter((item) => item.capsule_id !== capsuleID))
  }

  function openAssetGallery() {
    setAssetGalleryOpen((o) => !o)
    setSettingsOpen(false)
    setPlannerProviderOpen(false)
    setImageProviderOpen(false)
    setCountMenuOpen(false)
    if (!assetGalleryOpen) loadAssetGallery()
  }

  function openSettings() {
    setSettingsOpen((o) => !o)
    setAssetGalleryOpen(false)
    setPlannerProviderOpen(false)
    setImageProviderOpen(false)
    setCountMenuOpen(false)
  }

  function openPlannerProviderMenu() {
    setPlannerProviderOpen((o) => !o)
    setSettingsOpen(false)
    setAssetGalleryOpen(false)
    setImageProviderOpen(false)
    setCountMenuOpen(false)
  }

  function openImageProviderMenu() {
    setImageProviderOpen((o) => !o)
    setSettingsOpen(false)
    setAssetGalleryOpen(false)
    setPlannerProviderOpen(false)
    setCountMenuOpen(false)
  }

  function openCountMenu() {
    setCountMenuOpen((o) => !o)
    setSettingsOpen(false)
    setAssetGalleryOpen(false)
    setPlannerProviderOpen(false)
    setImageProviderOpen(false)
  }

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const current = editor.textContent ?? ''
    if (current !== draft && (draft === '' || document.activeElement !== editor)) {
      editor.textContent = draft
    }
  }, [draft])

  useEffect(() => {
    if (!settingsOpen && !assetGalleryOpen && !plannerProviderOpen && !imageProviderOpen && !countMenuOpen && !capsuleLookupOpen) return
    if (galleryPreview) return
    function handleClick(event: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false)
        setAssetGalleryOpen(false)
        setPlannerProviderOpen(false)
        setImageProviderOpen(false)
        setCountMenuOpen(false)
        setCapsuleLookupOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [settingsOpen, assetGalleryOpen, plannerProviderOpen, imageProviderOpen, countMenuOpen, capsuleLookupOpen, galleryPreview])

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
    targetSessionId: number, message: string, assetIds: number[], capsuleIds: string[], baseSettings: typeof settings,
    extra?: Partial<typeof settings> & { confirmed?: boolean; prompt?: string; assistant_message?: string },
  ) {
    if (!message.trim()) return
    const normalizedBaseSettings = normalizeGenerationSettings(baseSettings)
    setBusy(true)
    setError('')
    try {
      if (extra?.confirmed && extra.prompt) {
        setStreamingSessionId(targetSessionId)
        setToolDraft({ sessionId: targetSessionId, phase: 'calling', prompt: extra.prompt, raw: '' })
      }
      const res = await api.generate(targetSessionId, {
        message, asset_ids: assetIds, capsule_ids: capsuleIds, use_planner: usePlanner,
        planner_provider: selectedPlannerProvider, planner_model: selectedPlannerModel, image_provider: selectedImageProvider,
        ...normalizedBaseSettings, ...extra,
      })
      if (res.requires_confirmation) {
        setPendingRequest({ sessionId: targetSessionId, response: res, message, assetIds, capsuleIds, settings: normalizedBaseSettings })
        return
      }
      if (res.generated || res.message) { setDraft(''); clearSelectedAssets(); setSelectedCapsules([]) }
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
      const submittedCapsules = [...selectedCapsules]
      const submittedCapsuleIds = submittedCapsules.map((item) => item.capsule_id)
      const submittedSettings = normalizeGenerationSettings({ ...settings, ...overrides })
      const submittedAssets = assetsInSelectionOrder(submittedAssetIds, [...assets, ...libraryAssets])
      const capsuleLine = submittedCapsules.length > 0 ? `\n\n胶囊：${submittedCapsules.map((item) => `@${item.capsule_id}`).join('、')}` : ''
      const now = new Date().toISOString()
      setOptimisticMessages((items) => ({
        ...items,
        [targetSessionId]: [{ id: -Date.now(), session_id: targetSessionId, role: 'user', content: withReferenceMarkdown(submitted + capsuleLine, submittedAssets), created_at: now }],
      }))
      setDraft('')
      clearSelectedAssets()
      setSelectedCapsules([])
      setStreamingSessionId(targetSessionId)
      setStreamingText('')
      setThinkingText('')
      setToolDraft(null)
      await api.generateStream(targetSessionId, {
        message: submitted, asset_ids: submittedAssetIds, capsule_ids: submittedCapsuleIds, use_planner: usePlanner,
        planner_provider: selectedPlannerProvider, planner_model: selectedPlannerModel, image_provider: selectedImageProvider,
        ...submittedSettings,
      }, (event) => {
        if (event.type === 'content') setStreamingText((t) => t + event.text)
        else if (event.type === 'thinking') setThinkingText((t) => t + event.text)
        else if (event.type === 'confirm') {
          keepStream = true; toolUsed = true
          setPendingRequest({ sessionId: targetSessionId, response: event, message: submitted, assetIds: submittedAssetIds, capsuleIds: submittedCapsuleIds, settings: submittedSettings })
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
          setToolDraft((c) => ({
            sessionId: targetSessionId,
            phase: event.phase,
            raw: (c?.sessionId === targetSessionId ? c.raw : '') + (event.text ?? ''),
            prompt: event.prompt ?? c?.prompt ?? '',
            progress: event.progress ?? (c?.sessionId === targetSessionId ? c.progress : undefined),
          }))
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

  async function confirmWith(nextSettings: typeof settings, prompt: string) {
    if (!pendingRequest) return
    await requestGenerate(pendingRequest.sessionId, pendingRequest.message, pendingRequest.assetIds, pendingRequest.capsuleIds, pendingRequest.settings, {
      ...normalizeGenerationSettings(nextSettings), confirmed: true, prompt, assistant_message: pendingRequest.response.plan.assistant_message,
    })
    setPendingRequest(null)
  }

  async function copyPendingToNewConversation(nextSettings: typeof settings, prompt: string) {
    if (!pendingRequest) return
    setBusy(true)
    setError('')
    const newWindow = window.open('', '_blank')
    try {
      const res = await api.createSession('重新生成', 'chat')
      const copiedAssetIds: number[] = []
      for (const assetId of pendingRequest.assetIds) {
        const copied = await api.useAsset(res.session.id, assetId)
        copiedAssetIds.push(copied.asset.id)
      }
      const handoff: NewConversationDraft = {
        draft: prompt.trim() || pendingRequest.response.plan.prompt,
        assetIds: copiedAssetIds,
        settings: normalizeGenerationSettings(nextSettings),
        usePlanner: false,
        createdAt: Date.now(),
      }
      window.localStorage.setItem(`${NEW_CONVERSATION_DRAFT_PREFIX}${res.session.public_id}`, JSON.stringify(handoff))
      await onChanged()
      const target = `/chat/${res.session.public_id}`
      if (newWindow) {
        newWindow.location.href = target
      } else {
        window.location.href = target
      }
    } catch (err) {
      if (newWindow) newWindow.close()
      setError(err instanceof Error ? err.message : '创建新对话失败')
    } finally {
      setBusy(false)
    }
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
          <div className="rich-composer-input" onClick={() => editorRef.current?.focus()}>
            {selectedCapsules.map((capsule) => (
              <span key={capsule.capsule_id} className="capsule-token" contentEditable={false} title={capsule.title}>
                @{capsule.capsule_id}
                <button type="button" onClick={(event) => { event.stopPropagation(); removeCapsule(capsule.capsule_id) }} title="移除胶囊"><X size={12} /></button>
              </span>
            ))}
            <div
              ref={editorRef}
              className="rich-composer-editor"
              contentEditable
              suppressContentEditableWarning
              data-placeholder="描述你想要的画面，输入 @ 使用胶囊…"
              onInput={handleEditorInput}
              onKeyDown={(e) => {
                if (capsuleLookupOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  setCapsuleActiveIndex((index) => {
                    const count = Math.max(capsuleMatches.length, 1)
                    return e.key === 'ArrowDown' ? (index + 1) % count : (index - 1 + count) % count
                  })
                  return
                }
                if (capsuleLookupOpen && e.key === 'Enter' && capsuleMatches[capsuleActiveIndex]) {
                  e.preventDefault()
                  chooseCapsule(capsuleMatches[capsuleActiveIndex])
                  return
                }
                if (e.key === 'Backspace' && !editorText() && selectedCapsules.length > 0) {
                  e.preventDefault()
                  setSelectedCapsules((items) => items.slice(0, -1))
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  e.currentTarget.closest('form')?.requestSubmit()
                }
              }}
              onKeyUp={() => updateCapsuleLookup(editorText(), editorCaretOffset())}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
                if (files.length > 0) { e.preventDefault(); uploadFiles(files); return }
                e.preventDefault()
                const text = e.clipboardData.getData('text/plain')
                document.execCommand('insertText', false, text)
                handleEditorInput()
              }}
            />
          </div>
          {capsuleLookupOpen && (
            <div className="capsule-lookup" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}>
              {capsuleMatches.length === 0 && <div className="capsule-lookup-empty">没有匹配的胶囊</div>}
              {capsuleMatches.map((capsule, index) => (
                <button
                  key={capsule.id}
                  type="button"
                  className={index === capsuleActiveIndex ? 'active' : ''}
                  onClick={() => chooseCapsule(capsule)}
                >
                  {capsule.preview_url ? <img src={capsule.preview_url} alt="" /> : <span>@</span>}
                  <strong>{capsule.title}</strong>
                  <small>@{capsule.capsule_id}</small>
                </button>
              ))}
            </div>
          )}
          {hasCommandOverrides && (
            <div className="param-tags">
              {Object.entries(parsedCommands.overrides).map(([k, v]) => <span key={k} className="param-tag">{k}: {String(v)}</span>)}
            </div>
          )}
          <div className="composer-actions" ref={actionsRef}>
            <button type="button" className="icon-button" onClick={openAssetGallery} title="参考图库">
              {uploading ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
            </button>
            <button type="button" className="icon-button" onClick={openSettings} title={`生成参数：${selectedImageSizeLabel}`}>
              <SlidersHorizontal size={18} />
            </button>
            {settingsOpen && (
              <SettingsPopover settings={settings} setSettings={setSettings}
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
            <div className="composer-menu-wrap provider-menu-wrap planner-provider-menu-wrap">
              <button
                type="button"
                className="provider-menu-button"
                onClick={openPlannerProviderMenu}
                title={`Planner 模型${selectedPlannerProviderLabel ? `：${selectedPlannerProviderLabel}` : ''}`}
              >
                <span>{selectedPlannerProviderLabel || 'Planner 模型'}</span>
                <ChevronDown size={14} />
              </button>
              {plannerProviderOpen && (
                <PlannerProviderPopover
                  runtimeSettings={runtimeSettings}
                  value={selectedPlannerProvider}
                  onSelect={(value) => {
                    setPlannerProvider(value)
                    setPlannerProviderOpen(false)
                  }}
                  onClose={() => setPlannerProviderOpen(false)}
                />
              )}
            </div>
            <div className="composer-menu-wrap provider-menu-wrap">
              <button
                type="button"
                className="provider-menu-button"
                onClick={openImageProviderMenu}
                title={`图片 provider${selectedImageProviderLabel ? `：${selectedImageProviderLabel}` : ''}`}
              >
                <span>{selectedImageProviderLabel || '图片 provider'}</span>
                <ChevronDown size={14} />
              </button>
              {imageProviderOpen && (
                <ImageProviderPopover
                  runtimeSettings={runtimeSettings}
                  value={selectedImageProvider}
                  onSelect={(value) => { setImageProvider(value); setImageProviderOpen(false) }}
                  onClose={() => setImageProviderOpen(false)}
                />
              )}
            </div>
            <div className="composer-menu-wrap count-menu-wrap">
              <button
                type="button"
                className="count-menu-button"
                onClick={openCountMenu}
                title="数量"
              >
                <span>{`${effectiveSettings.count} 张`}</span>
                <ChevronDown size={14} />
              </button>
              {countMenuOpen && (
                <CountPopover
                  value={effectiveSettings.count}
                  onSelect={(value) => {
                    setSettings({ count: value })
                    setCountMenuOpen(false)
                  }}
                  onClose={() => setCountMenuOpen(false)}
                />
              )}
            </div>
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
          onAccept={(prompt) => confirmWith({ size: pendingRequest.response.plan.size, resolution: pendingRequest.response.plan.resolution, quality: pendingRequest.response.plan.quality, count: pendingRequest.response.plan.count }, prompt)}
          onKeepMine={(prompt) => confirmWith(pendingRequest.settings, prompt)}
          onCopyToNew={(prompt) => copyPendingToNewConversation({ size: pendingRequest.response.plan.size, resolution: pendingRequest.response.plan.resolution, quality: pendingRequest.response.plan.quality, count: pendingRequest.response.plan.count }, prompt)}
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

export function SettingsPopover({ settings, setSettings, onClose }: {
  settings: GenerationSettingsValue
  setSettings: (s: Partial<GenerationSettingsValue>) => void
  onClose: () => void
}) {
  return (
    <div className="settings-popover" onClick={(e) => e.stopPropagation()}>
      <div className="settings-popover-head">
        <strong>生成参数</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
      </div>
      <div className="settings-popover-body">
        <SettingsControls settings={settings} setSettings={setSettings} />
      </div>
    </div>
  )
}

export function PlannerProviderPopover({ runtimeSettings, value, onSelect, onClose }: {
  runtimeSettings: RuntimeSettings | null
  value: string
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const providers = runtimeSettings?.llm_providers.filter((p) => p.enabled && p.allow_user_select) ?? []
  return (
    <div className="image-provider-popover" onClick={(e) => e.stopPropagation()}>
      <div className="image-provider-popover-head">
        <strong>Planner 模型</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
      </div>
      <div className="image-provider-list">
        {providers.length === 0 && <p className="empty-note">暂无可选 provider</p>}
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className={`image-provider-option ${value === provider.id ? 'active' : ''}`}
            onClick={() => onSelect(provider.id)}
          >
            <span>{provider.name || provider.id}</span>
            {value === provider.id && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ImageProviderPopover({ runtimeSettings, value, onSelect, onClose }: {
  runtimeSettings: RuntimeSettings | null
  value: string
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const providers = runtimeSettings?.image_providers.filter((p) => p.enabled && p.allow_user_select) ?? []
  return (
    <div className="image-provider-popover" onClick={(e) => e.stopPropagation()}>
      <div className="image-provider-popover-head">
        <strong>图片 provider</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
      </div>
      <div className="image-provider-list">
        {providers.length === 0 && <p className="empty-note">暂无可选 provider</p>}
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className={`image-provider-option ${value === provider.id ? 'active' : ''}`}
            onClick={() => onSelect(provider.id)}
          >
            <span>{provider.name || provider.id}</span>
            {value === provider.id && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  )
}

export function CountPopover({ value, onSelect, onClose }: {
  value: number
  onSelect: (value: number) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <div className="count-popover" onClick={(e) => e.stopPropagation()}>
      <div className="count-popover-head">
        <strong>数量</strong>
        <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
      </div>
      <div className="count-popover-grid">
        {[1, 2, 3, 4].map((item) => (
          <button
            key={item}
            type="button"
            className={value === item ? 'active' : ''}
            onClick={() => onSelect(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <label className="count-popover-input">
        自定义
        <input
          type="number"
          min={1}
          max={4}
          value={draft}
          onChange={(e) => {
            const next = e.target.value
            setDraft(next)
            const parsed = Number(next)
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 4) onSelect(parsed)
          }}
        />
      </label>
    </div>
  )
}

export function SettingsControls({ settings, setSettings }: { settings: GenerationSettingsValue; setSettings: (s: Partial<GenerationSettingsValue>) => void }) {
  const locale = useAppStore((s) => s.locale)
  const normalizedSize = normalizeImageSize(settings.size, settings.resolution)
  const previewLabel = imageSizeLabel(normalizedSize)
  const selectedRatio = imageRatioFromSize(normalizedSize)
  const [customWidth, setCustomWidth] = useState(1024)
  const [customHeight, setCustomHeight] = useState(1024)
  const presetSize = imageSizeFromRatio(selectedRatio, settings.resolution)
  const isCustomSize = normalizedSize !== presetSize

  useEffect(() => {
    const parsed = normalizedSize.match(/^(\d+)x(\d+)$/)
    if (!parsed) return
    setCustomWidth(Number(parsed[1]))
    setCustomHeight(Number(parsed[2]))
  }, [normalizedSize])

  return (
    <div className="settings-controls">
      <div className="size-block">
        <div className="size-block-head">
          <strong>图像尺寸</strong>
          <span>当前 {previewLabel}</span>
        </div>
        <div className="size-grid">
          {IMAGE_RATIO_PRESETS.map((ratio) => (
            <button
              key={ratio}
              type="button"
              className={selectedRatio === ratio ? 'active' : ''}
              onClick={() => {
                setSettings({ size: imageSizeFromRatio(ratio, settings.resolution) })
              }}
            >
              {ratio}
            </button>
          ))}
        </div>
        <div className="size-grid size-resolution-grid">
          {IMAGE_RESOLUTION_PRESETS.map((resolution) => (
            <button
              key={resolution}
              type="button"
              className={settings.resolution === resolution ? 'active' : ''}
              onClick={() => {
                setSettings({
                  resolution,
                  size: isCustomSize
                    ? normalizeImageSize(`${customWidth}x${customHeight}`, resolution)
                    : imageSizeFromRatio(selectedRatio, resolution),
                })
              }}
            >
              {resolution}
            </button>
          ))}
        </div>
        <div className="custom-size-row">
          <label>
            宽
            <input
              type="number"
              min={64}
              max={4096}
              step={16}
              value={customWidth}
              onChange={(e) => {
                const width = Number(e.target.value)
                if (!Number.isFinite(width) || width <= 0) return
                const snapped = Math.max(64, Math.min(4096, Math.round(width / 16) * 16))
                setCustomWidth(snapped)
                setSettings({ size: normalizeImageSize(`${snapped}x${customHeight}`, settings.resolution) })
              }}
            />
          </label>
          <span className="custom-size-sep">x</span>
          <label>
            高
            <input
              type="number"
              min={64}
              max={4096}
              step={16}
              value={customHeight}
              onChange={(e) => {
                const height = Number(e.target.value)
                if (!Number.isFinite(height) || height <= 0) return
                const snapped = Math.max(64, Math.min(4096, Math.round(height / 16) * 16))
                setCustomHeight(snapped)
                setSettings({ size: normalizeImageSize(`${customWidth}x${snapped}`, settings.resolution) })
              }}
            />
          </label>
        </div>
      </div>
      <label title="high 约为 medium 的 4 倍成本。">
        质量
        <select value={settings.quality} onChange={(e) => setSettings({ quality: e.target.value })}>
          {['low', 'medium', 'high'].map((i) => <option key={i} value={i}>{localizeQuality(locale, i)}</option>)}
        </select>
      </label>
    </div>
  )
}

export function AssetGalleryPopover({ assets, selectedAssetIds, uploadProvider, setUploadProvider, runtimeSettings, uploading, loading, onUpload, onUse, onPreview, onClose }: {
  assets: Asset[]
  selectedAssetIds: number[]
  uploadProvider: string
  setUploadProvider: (p: string) => void
  runtimeSettings: RuntimeSettings | null
  uploading: boolean
  loading: boolean
  onUpload: () => void
  onUse: (a: Asset) => void | Promise<void>
  onPreview: (a: Asset) => void
  onClose: () => void
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
          <div
            key={asset.id}
            className={`asset-tile compact ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`}
            title={asset.file_name}
          >
            <img
              src={assetImageSrc(asset)}
              alt={asset.file_name}
            />
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

export function PlanConfirmDialog({ plan, settings, onAccept, onKeepMine, onCopyToNew, onCancel }: {
  plan: GenerationPlan
  settings: GenerationSettingsValue
  onAccept: (prompt: string) => void
  onKeepMine: (prompt: string) => void
  onCopyToNew: (prompt: string) => void
  onCancel: () => void
}) {
  const locale = useAppStore((s) => s.locale)
  const [promptDraft, setPromptDraft] = useState(plan.prompt)
  const changed = plan.size !== settings.size || plan.resolution !== settings.resolution || plan.quality !== settings.quality || plan.count !== settings.count
  const prompt = promptDraft.trim() || plan.prompt
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
                  <div className="param-row"><span>尺寸</span><span>{imageSizeLabel(settings.size)}</span></div>
                  <div className="param-row"><span>清晰度</span><span>{settings.resolution}</span></div>
                  <div className="param-row"><span>质量</span><span>{localizeQuality(locale, settings.quality)}</span></div>
                  <div className="param-row"><span>数量</span><span>{settings.count}</span></div>
                </div>
                <div className="plan-confirm-side">
                  <h4>AI 建议</h4>
                  <div className="param-row"><span>尺寸</span><span>{imageSizeLabel(plan.size)}</span></div>
                  <div className="param-row"><span>清晰度</span><span>{plan.resolution}</span></div>
                  <div className="param-row"><span>质量</span><span>{localizeQuality(locale, plan.quality)}</span></div>
                  <div className="param-row"><span>数量</span><span>{plan.count}</span></div>
                </div>
              </div>
            )}
            {plan.prompt && (
              <label className="prompt-edit-field">
                Prompt
                <textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} />
              </label>
            )}
            <div className="confirm-actions">
              <button className="secondary-button" onClick={() => onCopyToNew(prompt)}><MessageSquarePlus size={16} />复制到新对话</button>
              <button className="secondary-button" onClick={() => onKeepMine(prompt)}>保持我的参数</button>
              <button className="primary-button" onClick={() => onAccept(prompt)}>采用建议并生成</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

export function MobileMoreDrawer({ assets, selectedAssetIds, toggleAsset, settings, setSettings, usePlanner, setUsePlanner, onClose, onUpload }: {
  assets: Asset[]
  selectedAssetIds: number[]
  toggleAsset: (id: number) => void
  settings: GenerationSettingsValue
  setSettings: (s: Partial<GenerationSettingsValue>) => void
  usePlanner: boolean
  setUsePlanner: (v: boolean) => void
  onClose: () => void
  onUpload: () => void
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

export function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
}

export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-frame" onClick={(e) => e.stopPropagation()}>
        <button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <img src={src} alt="Preview" />
      </div>
    </div>
  )
}

export function Metric({ label, value, valueText }: { label: string; value?: number; valueText?: string }) {
  return <div className="metric"><span>{label}</span><strong>{valueText ?? value}</strong></div>
}

export function UsageBar({ bucket, maxCredits, granularity }: { bucket: UsageBucket; maxCredits: number; granularity: 'hour' | 'day' }) {
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

function userDisplayName(user: { display_name?: string | null; email?: string | null } | null) {
  return user?.display_name?.trim() || user?.email?.split('@')[0] || 'PicTu 用户'
}

function initialsFor(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return 'P'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length > 1) return parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase()
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase()
}
