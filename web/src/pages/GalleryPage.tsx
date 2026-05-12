import { useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Loader2, X, PackagePlus } from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import type { Asset, RuntimeSettings, UsageResponse } from '../types/api'
import { ImageLightbox } from '../components/workspace'
import { assetImageSrc, galleryItemsFromUsage } from '../lib/workspace'

export function GalleryPage({ activeSessionId, onSessionsChanged, runtimeSettings }: { activeSessionId: number | null; onSessionsChanged: () => void | Promise<void>; runtimeSettings: RuntimeSettings | null }) {
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
              {item.kind === 'asset' && <button className="asset-use" type="button" onClick={() => useAsset(item.asset)} title="使用"><PackagePlus size={14} /></button>}
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
