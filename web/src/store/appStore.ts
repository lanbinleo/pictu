import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '../types/api'

export type Page = 'workspace' | 'gallery' | 'chats' | 'settings' | 'admin'

type AppState = {
  token: string
  user: User | null
  activeSessionId: number | null
  draft: string
  selectedAssetIds: number[]
  settings: {
    size: string
    resolution: string
    quality: string
    count: number
  }
  theme: 'light' | 'dark'
  locale: 'zh-CN' | 'en-US'
  uploadProvider: string
  usePlanner: boolean
  page: Page
  setAuth: (token: string, user: User) => void
  clearAuth: () => void
  setUser: (user: User) => void
  setActiveSessionId: (id: number | null) => void
  setDraft: (draft: string) => void
  toggleAsset: (id: number) => void
  selectAsset: (id: number) => void
  deselectAsset: (id: number) => void
  clearSelectedAssets: () => void
  setSettings: (settings: Partial<AppState['settings']>) => void
  toggleTheme: () => void
  setLocale: (locale: AppState['locale']) => void
  setUploadProvider: (provider: string) => void
  setUsePlanner: (usePlanner: boolean) => void
  setPage: (page: Page) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      token: '',
      user: null,
      activeSessionId: null,
      draft: '',
      selectedAssetIds: [],
      settings: {
        size: 'auto',
        resolution: '1K',
        quality: 'medium',
        count: 1,
      },
      theme: 'light',
      locale: 'zh-CN',
      uploadProvider: 'evolink',
      usePlanner: true,
      page: 'workspace',
      setAuth: (token, user) => set({ token, user }),
      clearAuth: () => set({ token: '', user: null, activeSessionId: null, selectedAssetIds: [], page: 'workspace' }),
      setUser: (user) => set({ user }),
      setActiveSessionId: (id) => set({ activeSessionId: id, selectedAssetIds: [], page: 'workspace' }),
      setDraft: (draft) => set({ draft }),
      toggleAsset: (id) =>
        set((state) => ({
          selectedAssetIds: state.selectedAssetIds.includes(id)
            ? state.selectedAssetIds.filter((assetId) => assetId !== id)
            : [...state.selectedAssetIds, id],
        })),
      selectAsset: (id) =>
        set((state) => ({
          selectedAssetIds: state.selectedAssetIds.includes(id) ? state.selectedAssetIds : [...state.selectedAssetIds, id],
        })),
      deselectAsset: (id) => set((state) => ({ selectedAssetIds: state.selectedAssetIds.filter((assetId) => assetId !== id) })),
      clearSelectedAssets: () => set({ selectedAssetIds: [] }),
      setSettings: (settings) => set((state) => ({ settings: { ...state.settings, ...settings } })),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setLocale: (locale) => set({ locale }),
      setUploadProvider: (provider) => set({ uploadProvider: provider }),
      setUsePlanner: (usePlanner) => set({ usePlanner }),
      setPage: (page) => set({ page }),
    }),
    {
      name: 'pictu-app-state',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        activeSessionId: state.activeSessionId,
        draft: state.draft,
        settings: state.settings,
        theme: state.theme,
        locale: state.locale,
        uploadProvider: state.uploadProvider,
        usePlanner: state.usePlanner,
      }),
    },
  ),
)
