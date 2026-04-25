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
  created_at: string
  updated_at: string
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
