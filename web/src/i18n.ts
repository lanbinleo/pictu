export type Locale = 'zh-CN' | 'en-US'

const dictionaries = {
  'zh-CN': {
    status: {
      pending: '排队中',
      processing: '生成中',
      completed: '已完成',
      failed: '失败',
    },
    reason: {
      signup: '注册赠送',
      image_generation: '图片生成',
      llm_reply: '对话回复',
      generation_refund: '生成退款',
      admin_adjustment: '管理员调整',
    },
    quality: {
      low: '低',
      medium: '标准',
      high: '高',
    },
    role: {
      admin: '管理员',
      member: '成员',
    },
    tool: {
      preparing: '正在编写 Prompt',
      calling: '正在调用生图工具',
      prompt: '生成 Prompt',
    },
  },
  'en-US': {
    status: {
      pending: 'Pending',
      processing: 'Generating',
      completed: 'Completed',
      failed: 'Failed',
    },
    reason: {
      signup: 'Signup credits',
      image_generation: 'Image generation',
      llm_reply: 'Chat reply',
      generation_refund: 'Generation refund',
      admin_adjustment: 'Admin adjustment',
    },
    quality: {
      low: 'Low',
      medium: 'Standard',
      high: 'High',
    },
    role: {
      admin: 'Admin',
      member: 'Member',
    },
    tool: {
      preparing: 'Writing prompt',
      calling: 'Calling image tool',
      prompt: 'Generation prompt',
    },
  },
} as const

export function translate(locale: Locale, path: string, fallback = path) {
  const parts = path.split('.')
  let value: unknown = dictionaries[locale]
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !(part in value)) return fallback
    value = (value as Record<string, unknown>)[part]
  }
  return typeof value === 'string' ? value : fallback
}

export function localizeReason(locale: Locale, reason: string) {
  return translate(locale, `reason.${reason}`, reason.replace(/_/g, ' '))
}

export function localizeStatus(locale: Locale, status?: string) {
  if (!status) return ''
  return translate(locale, `status.${status}`, status)
}

export function localizeQuality(locale: Locale, quality: string) {
  return translate(locale, `quality.${quality}`, quality)
}
