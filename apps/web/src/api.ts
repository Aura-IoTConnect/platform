export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
export const WORKERS_URL = import.meta.env.VITE_WORKERS_URL ?? 'http://localhost:8000'

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

export class WorkersRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const WORKERS_TOKEN = import.meta.env.VITE_WORKERS_TOKEN

// apps/workers (agent trigger endpoints) is a separate service from apps/api
// and isn't behind the dashboard's JWT auth — see CLAUDE.md. If configured,
// it checks a shared bearer token instead (also just a basic abuse gate,
// since VITE_WORKERS_TOKEN ships in the browser bundle — see CLAUDE.md).
export async function workersPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WORKERS_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(WORKERS_TOKEN ? { authorization: `Bearer ${WORKERS_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new WorkersRequestError(res.status, detail?.detail ?? `POST ${path} failed`)
  }
  return res.json()
}
