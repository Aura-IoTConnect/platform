export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

let currentToken: string | null = null

export function setAuthToken(token: string | null) {
  currentToken = token
}

function authHeaders(): Record<string, string> {
  return currentToken ? { authorization: `Bearer ${currentToken}` } : {}
}

function handleResponse(res: Response) {
  if (res.status === 401) {
    window.dispatchEvent(new Event('auth:unauthorized'))
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() })
  handleResponse(res)
  if (!res.ok) throw new Error(`GET ${path} failed`)
  return res.json()
}

export async function apiSend<T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  handleResponse(res)
  if (!res.ok) throw new Error(`${method} ${path} failed`)
  return res.json()
}

export class ApiRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Agent triggers (POST /api/agents/{key}/run) proxy through apps/api rather
// than calling apps/workers directly from the browser — keeps them behind
// the same JWT auth as everything else, and keeps apps/workers'
// WORKERS_API_TOKEN server-side only. See CLAUDE.md.
export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { method: 'DELETE', headers: authHeaders() })
  handleResponse(res)
  if (!res.ok) throw new Error(`DELETE ${path} failed`)
}

export async function apiSendAgent<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  handleResponse(res)
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new ApiRequestError(res.status, detail?.detail ?? detail?.error ?? `POST ${path} failed`)
  }
  return res.json()
}
