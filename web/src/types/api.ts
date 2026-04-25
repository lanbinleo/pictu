export type User = {
  id: number
  tenant_id: number
  email: string
  display_name: string
  role: string
  credits: number
  created_at: string
}

export type Session = {
  id: number
  tenant_id: number
  user_id: number
  title: string
  task_status?: '' | 'pending' | 'processing' | 'completed' | 'failed'
  created_at: string
  updated_at: string
  archived_at?: string
}

export type Asset = {
  id: number
  session_id: number
  user_id: number
  file_name: string
  mime_type: string
  url: string
  size_bytes: number
  created_at: string
}

export type Message = {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  prompt?: string
  task_id?: string
  created_at: string
}

export type Task = {
  id: number
  session_id: number
  provider_task_id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  cost: number
  prompt: string
  result_json?: string
  error?: string
  created_at: string
  updated_at: string
}

export type SessionDetail = {
  session: Session
  assets: Asset[] | null
  messages: Message[] | null
  tasks: Task[] | null
}

export type CreditLedger = {
  id: number
  tenant_id: number
  user_id: number
  delta: number
  balance: number
  reason: string
  ref_id: string
  created_at: string
}

export type UsageSummary = {
  credits: number
  generated_tasks: number
  completed_tasks: number
  failed_tasks: number
  credits_spent: number
  reference_images: number
}

export type UsageResponse = {
  summary: UsageSummary
  ledger: CreditLedger[] | null
  assets: Asset[] | null
}

export type GenerationPlan = {
  prompt: string
  size: string
  resolution: string
  quality: string
  count: number
  assistant_message: string
  tool_called: boolean
}

export type SettingChange = {
  field: 'size' | 'resolution' | 'quality' | 'count'
  current: string | number
  recommended: string | number
}

export type GenerateResponse = {
  plan: GenerationPlan
  task?: Task
  message?: Message
  generated?: boolean
  requires_confirmation?: boolean
  setting_changes?: SettingChange[]
}

export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | ({ type: 'confirm' } & GenerateResponse)
  | ({ type: 'done' } & GenerateResponse)
  | { type: 'error'; error: string }
