import { useEffect, useMemo, useState } from 'react'
import { Check, PackagePlus, Plus, Search, Trash2, X } from 'lucide-react'
import { api, type CapsulePayload } from '../lib/api'
import type { Capsule } from '../types/api'

const emptyForm: CapsulePayload = {
  capsule_id: '',
  title: '',
  type: 'style',
  tags: [],
  preview_url: '',
  planner_instruction: '',
  direct_instruction: '',
}

export function CapsulesPage() {
  const [capsules, setCapsules] = useState<Capsule[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Capsule | null>(null)
  const [form, setForm] = useState<CapsulePayload>(emptyForm)
  const [tagText, setTagText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return capsules
    return capsules.filter((item) => [
      item.capsule_id,
      item.title,
      item.type,
      item.tags.join(' '),
    ].some((value) => value.toLowerCase().includes(q)))
  }, [capsules, query])

  async function loadCapsules() {
    setLoading(true)
    setError('')
    try {
      const res = await api.listCapsules()
      setCapsules(res.capsules ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '胶囊加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCapsules()
  }, [])

  function startCreate() {
    setEditing(null)
    setForm(emptyForm)
    setTagText('')
    setNotice('')
  }

  function startEdit(item: Capsule) {
    setEditing(item)
    setForm({
      capsule_id: item.capsule_id,
      title: item.title,
      type: item.type,
      tags: item.tags,
      preview_url: item.preview_url,
      planner_instruction: item.planner_instruction,
      direct_instruction: item.direct_instruction,
    })
    setTagText(item.tags.join(', '))
    setNotice('')
  }

  async function save() {
    const payload = {
      ...form,
      tags: tagText.split(',').map((tag) => tag.trim()).filter(Boolean),
    }
    if (!payload.capsule_id.trim() || !payload.title.trim()) {
      setError('胶囊 ID 和标题必填')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const res = editing
        ? await api.updateCapsule(editing.id, payload)
        : await api.createCapsule(payload)
      setCapsules((items) => {
        if (!editing) return [res.capsule, ...items]
        return items.map((item) => (item.id === res.capsule.id ? res.capsule : item))
      })
      setEditing(res.capsule)
      setForm({
        capsule_id: res.capsule.capsule_id,
        title: res.capsule.title,
        type: res.capsule.type,
        tags: res.capsule.tags,
        preview_url: res.capsule.preview_url,
        planner_instruction: res.capsule.planner_instruction,
        direct_instruction: res.capsule.direct_instruction,
      })
      setTagText(res.capsule.tags.join(', '))
      setNotice('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function remove(item: Capsule) {
    if (!window.confirm(`删除胶囊 ${item.capsule_id}？`)) return
    setError('')
    setNotice('')
    try {
      await api.deleteCapsule(item.id)
      setCapsules((items) => items.filter((current) => current.id !== item.id))
      if (editing?.id === item.id) startCreate()
      setNotice('已删除')
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="page-shell page-shell-wide page-shell-centered-header">
      <div className="page-header">
        <h1 className="page-title">胶囊</h1>
        <p className="page-subtitle">管理可复用的提示词资产，用 @ 挂到新对话里</p>
      </div>

      {error && <p className="form-error settings-alert">{error}</p>}
      {notice && <p className="form-success settings-alert">{notice}</p>}

      <div className="capsules-page">
        <section className="capsule-list-panel">
          <div className="capsule-toolbar">
            <label className="capsule-search">
              <Search size={16} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 ID、标题、类型或标签" />
            </label>
            <button type="button" className="secondary-button" onClick={startCreate}><Plus size={16} />新建</button>
          </div>
          <div className="capsule-list">
            {loading && <p className="empty-note">正在加载胶囊</p>}
            {!loading && filtered.length === 0 && <p className="empty-note">还没有胶囊</p>}
            {filtered.map((item) => (
              <button key={item.id} type="button" className={`capsule-row ${editing?.id === item.id ? 'active' : ''}`} onClick={() => startEdit(item)}>
                {item.preview_url ? <img src={item.preview_url} alt="" /> : <span className="capsule-row-icon"><PackagePlus size={18} /></span>}
                <span>
                  <strong>{item.title}</strong>
                  <small>@{item.capsule_id}</small>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="capsule-editor">
          <div className="panel-head">
            <h3>{editing ? '编辑胶囊' : '新建胶囊'}</h3>
            {editing && <button type="button" className="icon-button danger" onClick={() => remove(editing)} title="删除"><Trash2 size={16} /></button>}
          </div>
          <div className="capsule-form-grid">
            <label><span>胶囊 ID</span><input value={form.capsule_id} onChange={(e) => setForm({ ...form, capsule_id: e.target.value })} placeholder="style/anime" /></label>
            <label><span>标题</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="日漫风格" /></label>
            <label><span>类型</span><input value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="style" /></label>
            <label><span>标签</span><input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="anime, cel shading" /></label>
            <label className="capsule-wide"><span>预览图 URL</span><input value={form.preview_url} onChange={(e) => setForm({ ...form, preview_url: e.target.value })} placeholder="https://..." /></label>
            <label className="capsule-wide"><span>Planner instruction</span><textarea value={form.planner_instruction} onChange={(e) => setForm({ ...form, planner_instruction: e.target.value })} placeholder="告诉 Planner 如何把这个胶囊融入最终提示词" /></label>
            <label className="capsule-wide"><span>Direct instruction</span><textarea value={form.direct_instruction} onChange={(e) => setForm({ ...form, direct_instruction: e.target.value })} placeholder="不开 Planner 时直接加入最终 prompt 的文字" /></label>
          </div>
          <div className="capsule-editor-actions">
            <button type="button" className="secondary-button" onClick={startCreate}><X size={16} />清空</button>
            <button type="button" className="primary-button" disabled={saving} onClick={save}><Check size={16} />{saving ? '保存中' : '保存'}</button>
          </div>
        </section>
      </div>
    </div>
  )
}
