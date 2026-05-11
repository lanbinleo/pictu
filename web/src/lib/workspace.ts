import type { Asset, GenerateResponse, GenerationPlan, Message, SessionDetail, Task, UsageResponse, UsageBucket } from '../types/api'

export type GenerationSettingsValue = {
  size: string
  resolution: string
  quality: string
  count: number
}

export type PendingRequest = {
  sessionId: number
  response: GenerateResponse
  message: string
  assetIds: number[]
  settings: GenerationSettingsValue
}

export type NewConversationDraft = {
  draft: string
  assetIds: number[]
  settings: GenerationSettingsValue
  usePlanner: boolean
  createdAt: number
}

export type ToolDraft = {
  sessionId: number
  phase: 'preparing' | 'calling'
  prompt: string
  raw: string
}

export type CanvasNode = {
  id: string
  source: 'asset' | 'task' | 'local' | 'blank'
  asset_id?: number
  task_id?: number
  image_index?: number
  url: string
  title: string
  prompt?: string
  ratio?: string
  x: number
  y: number
  w: number
  h: number
}

export type CanvasState = {
  zoom: number
  panX: number
  panY: number
  nodes: CanvasNode[]
  hiddenSourceIds: string[]
}

export type GalleryItem =
  | { id: string; kind: 'asset'; asset: Asset; url: string; title: string; provider: string; created_at: string; generated: boolean }
  | { id: string; kind: 'task'; task: Task; url: string; title: string; provider: string; created_at: string; generated: true }

export type CanvasDragState =
  | { type: 'pan'; pointerId: number; startX: number; startY: number; panX: number; panY: number }
  | { type: 'nodes'; pointerId: number; startX: number; startY: number; nodes: Record<string, { x: number; y: number }> }
  | { type: 'select'; pointerId: number; startX: number; startY: number; currentX: number; currentY: number }

export const NEW_CONVERSATION_DRAFT_PREFIX = 'pictu-new-conversation-draft:'
export const defaultRemoveBackgroundPrompt = 'Remove the background from the selected image. Keep the subject unchanged, preserve edges and fine details, and output a transparent PNG.'

const COMMAND_PATTERNS: Record<string, RegExp> = {
  size: /--(?:ar|size)\s+([\w:]+)/i,
  resolution: /--(?:res|resolution)\s+(\w+)/i,
  quality: /--(?:q|quality)\s+(\w+)/i,
  count: /--(?:n|count)\s+(\d+)/i,
}

export function parseCommands(text: string): { cleanText: string; overrides: Partial<GenerationSettingsValue> } {
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

export function withReferenceMarkdown(text: string, assets: Asset[]) {
  if (assets.length === 0) return text
  const refs = assets.map((a, i) => `![图${i + 1}](${assetImageSrc(a)})`).join(' ')
  return `${text}\n\n${refs}`
}

export function splitReferenceMarkdown(text: string) {
  const refs: { alt: string; url: string }[] = []
  const cleaned = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) => { refs.push({ alt, url }); return '' })
    .replace(/\n{3,}/g, '\n\n').trim()
  return { text: cleaned || text, refs }
}

export function userDisplayName(user: { display_name?: string | null; email?: string | null } | null) {
  return user?.display_name?.trim() || user?.email?.split('@')[0] || 'PicTu 用户'
}

export function initialsFor(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return 'P'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length > 1) return parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase()
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase()
}

export function buildComposerGreeting(user: { display_name?: string | null; email?: string | null } | null) {
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

export function hashString(value: string) {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

export function uniqueAssets(assets: Asset[]) {
  const seen = new Set<string>()
  return assets.filter((a) => {
    const provider = a.provider || 'default'
    const key = a.content_hash ? `${provider}:hash:${a.content_hash}` : a.url ? `${provider}:url:${a.url}` : `asset:${a.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function assetsInSelectionOrder(ids: number[], assets: Asset[]) {
  const byID = new Map(assets.map((asset) => [asset.id, asset]))
  return ids.map((id) => byID.get(id)).filter((asset): asset is Asset => Boolean(asset))
}

export function galleryItemsFromUsage(data: UsageResponse | null): GalleryItem[] {
  const assetItems: Extract<GalleryItem, { kind: 'asset' }>[] = uniqueAssets(data?.assets ?? []).map((asset) => ({
    id: `asset-${asset.id}`,
    kind: 'asset' as const,
    asset,
    url: assetImageSrc(asset),
    title: asset.file_name,
    provider: providerLabel(asset),
    created_at: asset.last_used_at || asset.created_at,
    generated: isGeneratedAsset(asset),
  }))
  const assetURLs = new Set(assetItems.flatMap((item) => [item.asset.url, item.asset.local_url, item.url].filter(Boolean)))
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
    })).filter((item) => !assetURLs.has(item.url)),
  )
  return [...generatedFromTasks, ...assetItems].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export function assetImageSrc(asset: Asset) { return asset.local_url || asset.url }

export function isGeneratedAsset(asset: Asset) {
  const provider = (asset.provider || '').toLowerCase()
  return provider === 'generated' || provider === 'generation' || provider === 'task'
}

export function providerLabel(asset: Asset) {
  if (!asset.provider) return '未知渠道'
  if (asset.provider === 'evolink') return 'Evolink'
  if (asset.provider === 'maxqi') return 'MaxQi'
  return asset.provider
}

export function providerName(provider: string) {
  if (!provider) return '生成'
  if (provider === 'evolink') return 'Evolink'
  if (provider === 'maxqi') return 'MaxQi'
  return provider
}

export function emptyCanvasState(): CanvasState {
  return { zoom: 1, panX: 60, panY: 60, nodes: [], hiddenSourceIds: [] }
}

export function parseCanvasState(raw?: string): CanvasState {
  if (!raw) return emptyCanvasState()
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasState>
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter(isCanvasNode) : []
    const hiddenSourceIds = Array.isArray(parsed.hiddenSourceIds) ? parsed.hiddenSourceIds.filter((item): item is string => typeof item === 'string') : []
    return {
      zoom: clampNumber(parsed.zoom, 0.2, 3, 1),
      panX: typeof parsed.panX === 'number' ? parsed.panX : 60,
      panY: typeof parsed.panY === 'number' ? parsed.panY : 60,
      nodes,
      hiddenSourceIds,
    }
  } catch {
    return emptyCanvasState()
  }
}

export function isCanvasNode(value: unknown): value is CanvasNode {
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

export function mergeCanvasState(state: CanvasState, sources: CanvasNode[]): CanvasState {
  const byID = new Map(state.nodes.map((node) => [node.id, node]))
  const localNodes = state.nodes.filter((node) => node.source === 'local')
  const hiddenSourceIds = new Set(state.hiddenSourceIds)
  const merged = sources
    .filter((node) => !hiddenSourceIds.has(node.id))
    .map((node) => ({ ...node, ...byID.get(node.id), url: node.url, title: byID.get(node.id)?.title || node.title }))
  return { ...state, nodes: [...localNodes, ...merged] }
}

export function canvasNodesFromDetail(detail: SessionDetail | null): CanvasNode[] {
  if (!detail) return []
  const assetNodes = uniqueAssets(detail.assets ?? []).map((asset, index) => nodeFromAsset(asset, index))
  const assetURLs = new Set(assetNodes.flatMap((node) => [node.url].filter(Boolean)))
  const taskNodes = (detail.tasks ?? []).flatMap((task, taskIndex) =>
    extractImages(task).filter((url) => !assetURLs.has(url)).map((url, imageIndex) => ({
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
  return [...taskNodes, ...assetNodes]
}

export function nodeFromAsset(asset: Asset, index: number): CanvasNode {
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

export function upsertCanvasNode(nodes: CanvasNode[], node: CanvasNode) {
  if (nodes.some((item) => item.id === node.id)) return nodes.map((item) => (item.id === node.id ? { ...item, ...node } : item))
  return [node, ...nodes]
}

export function toggleSelection(selected: string[], id: string) {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]
}

export function rectFromPoints(x1: number, y1: number, x2: number, y2: number) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

export function rectIntersectsNode(rect: { x: number; y: number; w: number; h: number }, node: CanvasNode) {
  return rect.x < node.x + node.w && rect.x + rect.w > node.x && rect.y < node.y + node.h && rect.y + rect.h > node.y
}

export function screenRectToWorld(rect: { x: number; y: number; w: number; h: number }, canvas: CanvasState) {
  return {
    x: (rect.x - canvas.panX) / canvas.zoom,
    y: (rect.y - canvas.panY) / canvas.zoom,
    w: rect.w / canvas.zoom,
    h: rect.h / canvas.zoom,
  }
}

export function dimensionsForImage(width: number, height: number) {
  const maxSide = 260
  const minSide = 110
  if (width >= height) {
    const h = clamp((height / width) * maxSide, minSide, maxSide)
    return { w: maxSide, h }
  }
  const w = clamp((width / height) * maxSide, minSide, maxSide)
  return { w, h: maxSide }
}

export function dimensionsForRatio(ratio: string) {
  const [wRaw, hRaw] = ratio.split(':').map((part) => Number(part))
  const w = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1
  const h = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 1
  return dimensionsForImage(w, h)
}

export function ratioFromNode(node: CanvasNode) {
  if (node.ratio) return node.ratio
  const known = [
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['3:2', 3 / 2],
    ['2:3', 2 / 3],
  ] as const
  const current = node.w / node.h
  return known.reduce((best, item) => (Math.abs(item[1] - current) < Math.abs(best[1] - current) ? item : best), known[0])[0]
}

export function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values.filter((value) => value > 0)))
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

export function removeBackgroundFromURL(url: string): Promise<string> {
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

export function sampleEdgeColor(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
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

export function colorDistance(r: number, g: number, b: number, bg: [number, number, number]) {
  return Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
}

export function extractImages(task?: Task): string[] {
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
  } catch {
    return []
  }
}
