import { useAppStore } from '../store/appStore'
import type { AdminLedgerEntry, AdminStats, Asset, GenerateResponse, RuntimeLLMModel, RuntimeLLMProvider, RuntimeSettings, Session, SessionDetail, StreamEvent, Task, UsageResponse, User } from '../types/api'

type AuthResponse = {
  token: string
  user: User
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useAppStore.getState().token
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const res = await fetch(path, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`)
  }
  return data as T
}

export const api = {
  register: (payload: { email: string; password: string; display_name?: string }) =>
    request<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload: { email: string; password: string }) =>
    request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => request<{ user: User }>('/api/me'),
  updateMe: (payload: { email?: string; display_name?: string }) =>
    request<{ user: User }>('/api/me', { method: 'PUT', body: JSON.stringify(payload) }),
  updatePassword: (payload: { current_password: string; new_password: string }) =>
    request<{ ok: true }>('/api/me/password', { method: 'PUT', body: JSON.stringify(payload) }),
  uploadAvatar: (file: File) => {
    const data = new FormData()
    data.append('file', file)
    return request<{ user: User }>('/api/me/avatar', { method: 'POST', body: data })
  },
  listSessions: () => request<{ sessions: Session[] | null }>('/api/sessions'),
  listAllSessions: () => request<{ sessions: Session[] | null }>('/api/sessions/manage'),
  createSession: (title?: string, kind?: string) =>
    request<{ session: Session }>('/api/sessions', { method: 'POST', body: JSON.stringify({ title, kind }) }),
  updateSession: (id: number, title: string) =>
    request<{ session: Session }>(`/api/sessions/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }),
  updateSessionCanvas: (id: number, canvas_state: unknown) =>
    request<{ session: Session }>(`/api/sessions/${id}/canvas`, { method: 'PUT', body: JSON.stringify({ canvas_state }) }),
  archiveSession: (id: number) => request<{ ok: true }>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  unarchiveSession: (id: number) => request<{ session: Session }>(`/api/sessions/${id}/unarchive`, { method: 'POST' }),
  deleteSession: (id: number) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  getSession: (id: number) => request<SessionDetail>(`/api/sessions/${id}`),
  listAssets: () => request<{ assets: Asset[] | null }>('/api/assets'),
  runtimeSettings: () => request<{ settings: RuntimeSettings }>('/api/settings'),
  uploadAsset: (sessionId: number, file: File, provider?: string) => {
    const data = new FormData()
    data.append('file', file)
    if (provider) data.append('provider', provider)
    return request<{ asset: Asset }>(`/api/sessions/${sessionId}/assets`, { method: 'POST', body: data })
  },
  useAsset: (sessionId: number, assetId: number) =>
    request<{ asset: Asset }>(`/api/sessions/${sessionId}/assets/${assetId}/use`, { method: 'POST' }),
  deleteAsset: (assetId: number) => request<{ ok: true }>(`/api/assets/${assetId}`, { method: 'DELETE' }),
  generate: (
    sessionId: number,
    payload: {
      message: string
      asset_ids: number[]
      size: string
      resolution: string
      quality: string
      count: number
      confirmed?: boolean
      prompt?: string
      assistant_message?: string
      use_planner?: boolean
      planner_provider?: string
      planner_model?: string
      image_provider?: string
    },
  ) =>
    request<GenerateResponse>(`/api/sessions/${sessionId}/generate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateStream: async (
    sessionId: number,
    payload: {
      message: string
      asset_ids: number[]
      size: string
      resolution: string
      quality: string
      count: number
      use_planner?: boolean
      planner_provider?: string
      planner_model?: string
      image_provider?: string
    },
    onEvent: (event: StreamEvent) => void,
  ) => {
    const token = useAppStore.getState().token
    const res = await fetch(`/api/sessions/${sessionId}/generate/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Request failed: ${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const event = parseSSE(part)
        if (event) onEvent(event)
      }
    }
    if (buffer.trim()) {
      const event = parseSSE(buffer)
      if (event) onEvent(event)
    }
  },
  getTask: (id: number) => request<{ task: Task }>(`/api/tasks/${id}`),
  usage: () => request<UsageResponse>('/api/usage'),
  adminUsers: () => request<{ users: User[] | null }>('/api/admin/users'),
  adminAdjustCredits: (id: number, payload: { delta: number; reason?: string }) =>
    request<{ user: User }>(`/api/admin/users/${id}/credits`, { method: 'POST', body: JSON.stringify(payload) }),
  adminStats: (granularity: 'hour' | 'day' = 'hour', window = granularity === 'hour' ? 24 : 30) =>
    request<AdminStats>(`/api/admin/stats?granularity=${granularity}&days=${window}`),
  adminLedger: (limit = 200) => request<{ entries: AdminLedgerEntry[] | null }>(`/api/admin/ledger?limit=${limit}`),
  adminSettings: () => request<{ settings: RuntimeSettings }>('/api/admin/settings'),
  adminSaveSettings: (settings: RuntimeSettings) =>
    request<{ settings: RuntimeSettings }>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ settings }) }),
  adminLLMProviderModels: (provider: RuntimeLLMProvider) =>
    request<{ models: RuntimeLLMModel[] | null }>('/api/admin/llm-provider-models', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
}

function parseSSE(chunk: string): StreamEvent | null {
  const lines = chunk.split('\n')
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
  if (!eventName || !data) return null
  const parsed = JSON.parse(data)
  return { type: eventName, ...parsed } as StreamEvent
}
