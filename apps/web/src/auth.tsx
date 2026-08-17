import { createContext, useContext, useState, type ReactNode } from 'react'
import { API_URL, setAuthToken } from './api'

interface AuthUser {
  id: string
  email: string
  role: 'ADMIN' | 'OPERATOR'
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

const STORAGE_KEY = 'iotplatform.auth'

function loadStored(): { token: string; user: AuthUser } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const stored = loadStored()
  const [token, setToken] = useState<string | null>(stored?.token ?? null)
  const [user, setUser] = useState<AuthUser | null>(stored?.user ?? null)

  // Set synchronously during render (not in a useEffect) so the token is in
  // place in api.ts before any child's mount-time fetch fires — child effects
  // run before a parent's own effects, so a useEffect here would be too late
  // and the first authenticated request would race a stale/null token.
  setAuthToken(token)

  const login = async (email: string, password: string) => {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error('Invalid email or password')
    const data = await res.json()
    setToken(data.token)
    setUser(data.user)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: data.token, user: data.user }))
  }

  const logout = () => {
    setToken(null)
    setUser(null)
    localStorage.removeItem(STORAGE_KEY)
  }

  return <AuthContext.Provider value={{ token, user, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
