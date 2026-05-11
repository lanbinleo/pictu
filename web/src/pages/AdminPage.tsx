import { useEffect, useState } from 'react'
import { BarChart3, Camera, Check, CreditCard, ImagePlus, Plus, ScrollText, Settings2, Sparkles, Users } from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store/appStore'
import type { AdminStats, RuntimeLLMModel, RuntimeSettings, User } from '../types/api'
import { Metric, UsageBar } from '../components/workspace'
import { localizeReason, translate } from '../i18n'

export function AdminPage() {
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
  const imageModelListId = 'image-models-list'

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
            <div className="panel-head">
              <h3>图片 provider</h3>
              <button type="button" className="secondary-button" onClick={() => patch({ image_providers: [...settings.image_providers, { id: `image-${settings.image_providers.length + 1}`, name: 'New Image', type: 'right_codes', base_url: 'https://www.right.codes/draw', files_base_url: '', api_key: '', model: 'gpt-image-2', credit_multiplier: 1, allow_user_select: true, use_builtin_storage: true, enabled: true }] })}><Plus size={16} />新增</button>
            </div>
            {settings.image_providers.map((p, i) => (
              <div className="provider-editor" key={`${p.id}-${i}`}>
                <label><span>ID</span><input value={p.id} onChange={(e) => patchImage(i, { id: e.target.value })} /></label>
                <label><span>模型昵称</span><input value={p.name} onChange={(e) => patchImage(i, { name: e.target.value })} /></label>
                <label><span>类型</span><select value={p.type} onChange={(e) => patchImage(i, { type: e.target.value })}><option value="evolink">evolink</option><option value="right_codes">right_codes</option></select></label>
                <label><span>Model</span><input list={imageModelListId} value={p.model} onChange={(e) => patchImage(i, { model: e.target.value })} /></label>
                <label><span>Base URL</span><input value={p.base_url} onChange={(e) => patchImage(i, { base_url: e.target.value })} /></label>
                <label><span>Files Base URL</span><input value={p.files_base_url} onChange={(e) => patchImage(i, { files_base_url: e.target.value })} /></label>
                <label><span>API Key</span><input value={p.api_key} onChange={(e) => patchImage(i, { api_key: e.target.value })} /></label>
                <label><span>Multiplier</span><input type="number" step="0.01" value={p.credit_multiplier} onChange={(e) => patchImage(i, { credit_multiplier: numberValue(e.target.value) })} /></label>
                <label className="toggle-row"><input type="checkbox" checked={p.allow_user_select} onChange={(e) => patchImage(i, { allow_user_select: e.target.checked })} /><span>允许用户选择</span></label>
                <label className="toggle-row"><input type="checkbox" checked={Boolean(p.use_builtin_storage)} onChange={(e) => patchImage(i, { use_builtin_storage: e.target.checked })} /><span>使用内置图床</span></label>
                <label className="toggle-row"><input type="checkbox" checked={p.enabled} onChange={(e) => patchImage(i, { enabled: e.target.checked })} /><span>启用</span></label>
              </div>
            ))}
          </section>
        )}
        <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
          <datalist id={imageModelListId}>
            <option value="gpt-image-2">gpt-image-2</option>
            <option value="gpt-image-2-vip">gpt-image-2-vip</option>
          </datalist>
        </div>
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
