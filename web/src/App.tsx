import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthScreen } from './pages/AuthScreen'
import { Workspace } from './Workspace'
import { useAppStore } from './store/appStore'

export function App() {
  const token = useAppStore((s) => s.token)
  const theme = useAppStore((s) => s.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <BrowserRouter>
      <RoutesShell token={token} />
    </BrowserRouter>
  )
}

function RoutesShell({ token }: { token: string }) {
  const location = useLocation()
  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<AuthScreen />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ next: `${location.pathname}${location.search}` }} />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/new" replace />} />
      <Route path="/" element={<Navigate to="/new" replace />} />
      <Route path="*" element={<Workspace />} />
    </Routes>
  )
}
