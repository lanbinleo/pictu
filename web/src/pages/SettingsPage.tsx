import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Camera, Check, CreditCard, KeyRound, Languages, Lock, Loader2, Mail, Moon, Sun, UserRound } from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import type { UsageResponse } from '../types/api'
import { Metric, UserAvatar } from '../components/workspace'
import { localizeReason } from '../i18n'
import { userDisplayName } from '../lib/workspace'

export function SettingsPage() {
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
