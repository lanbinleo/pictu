export type User = {
  id: number
  tenant_id: number
  email: string
  display_name: string
  avatar_url?: string
  role: string
  credits: number
  created_at: string
}

export type Session = {
  id: number
  public_id: string
  tenant_id: number
  user_id: number
  title: string
  kind: 'chat' | 'canvas'
  canvas_state?: string
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
  local_url?: string
  size_bytes: number
  provider: string
  content_hash: string
  created_at: string
  last_used_at?: string
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
  provider: string
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
  tasks?: Task[] | null
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
  | { type: 'tool'; phase: 'preparing' | 'calling'; text?: string; prompt?: string; progress?: number }
  | ({ type: 'confirm' } & GenerateResponse)
  | ({ type: 'done' } & GenerateResponse)
  | { type: 'error'; error: string }

export type DailyBucket = {
  date: string
  tasks: number
  credits: number
}

export type RuntimeBilling = {
  signup_credits: number
  llm_base_cost: number
  image_base_cost: number
  image_input_cost: number
  high_quality_multiplier: number
  low_quality_multiplier: number
}

export type RuntimeDefaults = {
  planner_provider: string
  planner_model: string
  title_provider: string
  title_model: string
  upload_provider: string
  image_provider: string
}

export type RuntimePrompts = {
  planner_system_prompt: string
}

export type RuntimeLLMProvider = {
  id: string
  name: string
  type: string
  base_url: string
  api_key: string
  planner_model: string
  title_model: string
  timeout_seconds: number
  max_context_messages: number
  credit_multiplier: number
  supports_vision: boolean
  allow_user_select: boolean
  enabled: boolean
}

export type RuntimeLLMModel = {
  id: string
  name: string
  supports_vision: boolean
}

export type RuntimeUploadProvider = {
  id: string
  name: string
  type: string
  base_url: string
  token: string
  strategy_id: number
  enabled: boolean
}

export type RuntimeImageProvider = {
  id: string
  name: string
  type: string
  base_url: string
  files_base_url: string
  api_key: string
  model: string
  credit_multiplier: number
  allow_user_select: boolean
  use_builtin_storage: boolean
  enabled: boolean
}

export type RuntimeSettings = {
  billing: RuntimeBilling
  defaults: RuntimeDefaults
  prompts: RuntimePrompts
  llm_providers: RuntimeLLMProvider[]
  upload_providers: RuntimeUploadProvider[]
  image_providers: RuntimeImageProvider[]
}

export type UsageBucket = {
  period: string
  tasks: number
  credits: number
  text_credits: number
  image_credits: number
}

export type AdminStats = {
  total_users: number
  total_sessions: number
  total_tasks: number
  total_credits_spent: number
  daily_usage: DailyBucket[] | null
  usage_buckets: UsageBucket[] | null
}

export type AdminLedgerEntry = {
  id: number
  user_id: number
  user_email: string
  delta: number
  balance: number
  reason: string
  ref_id: string
  created_at: string
}
