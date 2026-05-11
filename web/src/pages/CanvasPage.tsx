import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Move, PanelLeft, Wand2, ZoomIn, ZoomOut } from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import type { Asset, RuntimeSettings, SessionDetail } from '../types/api'
import { EditableTitle } from '../components/workspace'
import { assetImageSrc, canvasNodesFromDetail, clamp, defaultRemoveBackgroundPrompt, dimensionsForImage, dimensionsForRatio, emptyCanvasState, mergeCanvasState, nodeFromAsset, parseCanvasState, ratioFromNode, rectFromPoints, rectIntersectsNode, removeBackgroundFromURL, screenRectToWorld, toggleSelection, uniqueAssets, uniqueNumbers, upsertCanvasNode, type CanvasDragState, type CanvasNode, type CanvasState } from '../lib/workspace'

export function CanvasPage({ detail, sessionId, runtimeSettings, onChanged, onRename, onOpenMenu }: {
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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [panelTab, setPanelTab] = useState<'image' | 'assets'>('image')
  const [promptDraft, setPromptDraft] = useState('')
  const [ratioDraft, setRatioDraft] = useState('1:1')
  const [removePrompt, setRemovePrompt] = useState(defaultRemoveBackgroundPrompt)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([])
  const [stagedAssetIds, setStagedAssetIds] = useState<number[]>([])
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; worldX: number; worldY: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<CanvasDragState | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const sessionRef = useRef<number | null>(null)
  const canvasStateRef = useRef<string | undefined>(undefined)
  const selected = selectedIds.length === 1 ? canvas.nodes.find((node) => node.id === selectedIds[0]) ?? null : null
  const selectedNodes = selectedIds.map((id) => canvas.nodes.find((node) => node.id === id)).filter((node): node is CanvasNode => Boolean(node))
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
      setRatioDraft('1:1')
      return
    }
    setPromptDraft(selected.prompt || '')
    setRatioDraft(selected.ratio || ratioFromNode(selected))
  }, [selected?.id])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
  }, [])

  async function loadLibrary() {
    try {
      const res = await api.listAssets()
      setLibraryAssets(uniqueAssets(res.assets ?? []))
    } catch (err) {
      setError(err instanceof Error ? err.message : '图库加载失败')
    }
  }

  useEffect(() => {
    if (panelTab !== 'assets') return
    loadLibrary()
  }, [panelTab])

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
      updateCanvas((current) => ({
        ...current,
        nodes: upsertCanvasNode(current.nodes, node),
        hiddenSourceIds: current.hiddenSourceIds.filter((id) => id !== node.id),
      }))
      setSelectedIds([node.id])
      setPanelTab('image')
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加图片失败')
    }
  }

  function toggleLibraryReference(asset: Asset) {
    setStagedAssetIds((items) => (items.includes(asset.id) ? items.filter((id) => id !== asset.id) : [...items, asset.id]))
  }

  function updateSelectedPrompt(value: string) {
    setPromptDraft(value)
    if (!selected) return
    updateCanvas((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === selected.id ? { ...node, prompt: value } : node)),
    }))
  }

  function updateSelectedRatio(value: string) {
    setRatioDraft(value)
    if (!selected) return
    const dims = dimensionsForRatio(value)
    updateCanvas((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === selected.id ? { ...node, ratio: value, w: dims.w, h: dims.h } : node)),
    }))
  }

  function fitNodeToImage(id: string, img: HTMLImageElement) {
    if (!img.naturalWidth || !img.naturalHeight) return
    updateCanvas((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== id || node.ratio) return node
        const dims = dimensionsForImage(img.naturalWidth, img.naturalHeight)
        return { ...node, w: dims.w, h: dims.h }
      }),
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
        size: selected?.ratio || settings.size,
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
      setSelectedIds([node.id])
    } catch (err) {
      setError(err instanceof Error ? err.message : '本地去背景失败')
    } finally {
      setBusy(false)
    }
  }

  function stagePoint(event: React.PointerEvent<HTMLDivElement>) {
    const rect = stageRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return {
      x: event.clientX - left,
      y: event.clientY - top,
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    panelRef.current?.focus()
    setContextMenu(null)
    if (event.button === 1) {
      event.preventDefault()
      dragRef.current = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: canvas.panX, panY: canvas.panY }
    } else if (event.button === 0) {
      const point = stagePoint(event)
      dragRef.current = { type: 'select', pointerId: event.pointerId, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y }
      setSelectionRect(null)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleNodePointerDown(event: React.PointerEvent<HTMLDivElement>, node: CanvasNode) {
    event.stopPropagation()
    panelRef.current?.focus()
    setContextMenu(null)
    if (event.button === 1) {
      event.preventDefault()
      dragRef.current = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: canvas.panX, panY: canvas.panY }
      stageRef.current?.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    const nextSelected = event.shiftKey
      ? toggleSelection(selectedIds, node.id)
      : selectedIds.includes(node.id) ? selectedIds : [node.id]
    setSelectedIds(nextSelected)
    setPanelTab('image')
    const selectedForDrag = event.shiftKey ? nextSelected : nextSelected.length > 0 ? nextSelected : [node.id]
    const positions: Record<string, { x: number; y: number }> = {}
    for (const item of canvas.nodes) {
      if (selectedForDrag.includes(item.id)) positions[item.id] = { x: item.x, y: item.y }
    }
    dragRef.current = { type: 'nodes', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, nodes: positions }
    stageRef.current?.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    if (drag.type === 'select') {
      const point = stagePoint(event)
      dragRef.current = { ...drag, currentX: point.x, currentY: point.y }
      setSelectionRect(rectFromPoints(drag.startX, drag.startY, point.x, point.y))
      return
    }
    updateCanvas((current) => {
      if (drag.type === 'pan') {
        return { ...current, panX: drag.panX + event.clientX - drag.startX, panY: drag.panY + event.clientY - drag.startY }
      }
      const dx = (event.clientX - drag.startX) / current.zoom
      const dy = (event.clientY - drag.startY) / current.zoom
      return {
        ...current,
        nodes: current.nodes.map((node) => {
          const start = drag.nodes[node.id]
          return start ? { ...node, x: start.x + dx, y: start.y + dy } : node
        }),
      }
    })
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (drag?.type === 'select') {
      const rect = rectFromPoints(drag.startX, drag.startY, drag.currentX, drag.currentY)
      const moved = rect.w > 4 || rect.h > 4
      const worldRect = screenRectToWorld(rect, canvas)
      setSelectedIds(moved ? canvas.nodes.filter((node) => rectIntersectsNode(worldRect, node)).map((node) => node.id) : [])
      setSelectionRect(null)
    }
    dragRef.current = null
    if (stageRef.current?.hasPointerCapture(event.pointerId)) stageRef.current.releasePointerCapture(event.pointerId)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    if (selectedIds.length === 0) return
    event.preventDefault()
    updateCanvas((current) => {
      const hiddenSourceIds = new Set(current.hiddenSourceIds)
      for (const node of current.nodes) {
        if (selectedIds.includes(node.id) && node.source !== 'local') hiddenSourceIds.add(node.id)
      }
      return {
        ...current,
        nodes: current.nodes.filter((node) => !selectedIds.includes(node.id) || node.source === 'local'),
        hiddenSourceIds: Array.from(hiddenSourceIds),
      }
    })
    setSelectedIds([])
  }

  function openContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    setContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      worldX: (event.clientX - rect.left - canvas.panX) / canvas.zoom,
      worldY: (event.clientY - rect.top - canvas.panY) / canvas.zoom,
    })
  }

  function createBlankNode(ratio: string) {
    if (!contextMenu) return
    const size = dimensionsForRatio(ratio)
    const node: CanvasNode = {
      id: `blank-${Date.now()}`,
      source: 'blank',
      url: '',
      title: '空白图片',
      prompt: '',
      ratio,
      x: contextMenu.worldX,
      y: contextMenu.worldY,
      w: size.w,
      h: size.h,
    }
    updateCanvas((current) => ({ ...current, nodes: [node, ...current.nodes] }))
    setSelectedIds([node.id])
    setPanelTab('image')
    setContextMenu(null)
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

  const selectedAssetIDs = uniqueNumbers([
    ...selectedNodes.map((node) => node.asset_id ?? 0).filter(Boolean),
    ...stagedAssetIds,
  ])

  return (
    <section ref={panelRef} className="canvas-panel" tabIndex={0} onKeyDown={handleKeyDown}>
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
          onContextMenu={openContextMenu}
          onWheel={zoomAt}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); uploadFiles(event.dataTransfer.files) }}
        >
          <div className="canvas-grid" style={{ transform: `translate(${canvas.panX}px, ${canvas.panY}px) scale(${canvas.zoom})` }}>
            {canvas.nodes.map((node) => (
              <div
                key={node.id}
                className={`canvas-node ${selectedIds.includes(node.id) ? 'selected' : ''} ${node.source === 'blank' ? 'blank' : ''}`}
                style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
              >
                {node.url ? <img src={node.url} alt={node.title} draggable={false} onLoad={(event) => fitNodeToImage(node.id, event.currentTarget)} /> : <div className="canvas-blank-preview" />}
                <span>{node.title}</span>
              </div>
            ))}
          </div>
          {selectionRect && (
            <div
              className="canvas-selection-box"
              style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.w, height: selectionRect.h }}
            />
          )}
          {contextMenu && (
            <div className="canvas-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={() => createBlankNode('1:1')}>新建 1:1</button>
              <button type="button" onClick={() => createBlankNode('4:3')}>新建 4:3</button>
              <button type="button" onClick={() => createBlankNode('3:4')}>新建 3:4</button>
              <button type="button" onClick={() => createBlankNode('16:9')}>新建 16:9</button>
              <button type="button" onClick={() => createBlankNode('9:16')}>新建 9:16</button>
            </div>
          )}
          {canvas.nodes.length === 0 && (
            <div className="canvas-empty">
              <Move size={24} />
              <p>把图片拖到这里，或从右侧添加图片</p>
            </div>
          )}
        </div>
        <aside className="canvas-inspector">
          <div className="canvas-inspector-head">
            <strong>{selectedNodes.length > 1 ? `已选 ${selectedNodes.length} 张` : selected ? '图像信息' : '画布'}</strong>
          </div>
          <div className="canvas-tabs" role="tablist">
            <button type="button" className={panelTab === 'image' ? 'active' : ''} onClick={() => setPanelTab('image')}>图像</button>
            <button type="button" className={panelTab === 'assets' ? 'active' : ''} onClick={() => setPanelTab('assets')}>图库</button>
          </div>
          <div className="canvas-tools">
            <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="spin" size={16} /> : <ImagePlus size={16} />}
              上传图片
            </button>
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
          {panelTab === 'assets' && (
            <div className="canvas-library">
              {libraryAssets.map((asset) => (
                <div key={asset.id} className={`canvas-library-item ${stagedAssetIds.includes(asset.id) ? 'selected' : ''}`} title={asset.file_name}>
                  <button type="button" className="canvas-library-thumb" onClick={() => addLibraryAsset(asset)}>
                    <img src={assetImageSrc(asset)} alt={asset.file_name} />
                  </button>
                  <button type="button" className="canvas-library-ref" onClick={() => toggleLibraryReference(asset)}>
                    {stagedAssetIds.includes(asset.id) ? '已挂载' : '挂载'}
                  </button>
                </div>
              ))}
              {libraryAssets.length === 0 && <p className="empty-note">图库里还没有图片</p>}
              {stagedAssetIds.length > 0 && <p className="empty-note">已挂载 {stagedAssetIds.length} 张，会随当前选中图片一起作为参考图。</p>}
            </div>
          )}
          {panelTab === 'image' && selected ? (
            <div className="canvas-selected">
              {selected.url ? <img src={selected.url} alt={selected.title} /> : <div className="canvas-selected-blank" />}
              <div className="param-row"><span>来源</span><span>{selected.source === 'asset' ? '参考图' : selected.source === 'task' ? '生成图' : selected.source === 'blank' ? '空白图' : '本地图'}</span></div>
              <label>
                比例
                <select value={ratioDraft} onChange={(e) => updateSelectedRatio(e.target.value)}>
                  {['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
              </label>
              <label>
                提示词
                <textarea value={promptDraft} onChange={(e) => updateSelectedPrompt(e.target.value)} placeholder="为这张图记录或修改提示词" />
              </label>
              {stagedAssetIds.length > 0 && <p className="empty-note">当前会使用 {selectedAssetIDs.length} 张参考图。</p>}
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
            </div>
          ) : panelTab === 'image' && selectedNodes.length > 1 ? (
            <div className="canvas-selected empty">
              <p className="empty-note">已选 {selectedNodes.length} 张。可以拖动它们，按 Delete 从画布移除，或把它们作为参考图生成。</p>
              <label>
                提示词
                <textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} placeholder="描述要生成的新图片" />
              </label>
              <button className="primary-button" type="button" disabled={busy} onClick={() => generateFromPrompt(promptDraft, selectedAssetIDs)}>
                {busy ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
                用所选图片生成
              </button>
            </div>
          ) : panelTab === 'image' ? (
            <div className="canvas-selected empty">
              <p className="empty-note">选择一张图片后，可以编辑提示词、创建新图片或去背景。</p>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  )
}
