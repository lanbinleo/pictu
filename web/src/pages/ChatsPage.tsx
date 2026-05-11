import { useEffect, useMemo, useState } from 'react'
import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import type { Session } from '../types/api'

export function ChatsPage({ sessions, onSelect, onRefresh }: {
  sessions: Session[]
  onSelect: (id: number) => void
  onArchive: (id: number) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const [allSessions, setAllSessions] = useState<Session[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

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
