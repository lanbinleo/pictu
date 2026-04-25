import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '../types/api'

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
  setAuth: (token: string, user: User) => void
  clearAuth: () => void
  setUser: (user: User) => void
  setActiveSessionId: (id: number | null) => void
  setDraft: (draft: string) => void
  toggleAsset: (id: number) => void
  clearSelectedAssets: () => void
  setSettings: (settings: Partial<AppState['settings']>) => void
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
      setAuth: (token, user) => set({ token, user }),
      clearAuth: () => set({ token: '', user: null, activeSessionId: null, selectedAssetIds: [] }),
      setUser: (user) => set({ user }),
      setActiveSessionId: (id) => set({ activeSessionId: id, selectedAssetIds: [] }),
      setDraft: (draft) => set({ draft }),
      toggleAsset: (id) =>
        set((state) => ({
          selectedAssetIds: state.selectedAssetIds.includes(id)
            ? state.selectedAssetIds.filter((assetId) => assetId !== id)
            : [...state.selectedAssetIds, id],
        })),
      clearSelectedAssets: () => set({ selectedAssetIds: [] }),
      setSettings: (settings) => set((state) => ({ settings: { ...state.settings, ...settings } })),
    }),
    {
      name: 'pictu-app-state',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        activeSessionId: state.activeSessionId,
        draft: state.draft,
        settings: state.settings,
      }),
    },
  ),
)
