import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, apiDelete, apiGet, apiGetText, apiSend, apiSendAgent, setAuthToken } from './api'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('api client', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    setAuthToken(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const lastCall = () => fetchMock.mock.calls[0] as [string, RequestInit]

  it('sends no Authorization header until a token is set', async () => {
    fetchMock.mockResolvedValueOnce(json([]))
    await apiGet('/api/devices')
    expect(lastCall()[0]).toBe('http://localhost:4000/api/devices')
    expect(lastCall()[1].headers).toEqual({})
  })

  it('sends the bearer token once set, and stops after it is cleared', async () => {
    setAuthToken('abc')
    fetchMock.mockResolvedValueOnce(json({}))
    await apiGet('/x')
    expect(lastCall()[1].headers).toEqual({ authorization: 'Bearer abc' })

    setAuthToken(null)
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(json({}))
    await apiGet('/x')
    expect(lastCall()[1].headers).toEqual({})
  })

  it('a 401 broadcasts auth:unauthorized (so the app logs out) and still rejects', async () => {
    const onUnauthorized = vi.fn()
    window.addEventListener('auth:unauthorized', onUnauthorized)
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 401))

    await expect(apiGet('/api/devices')).rejects.toThrow('GET /api/devices failed')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    window.removeEventListener('auth:unauthorized', onUnauthorized)
  })

  it('a non-401 failure rejects without logging the user out', async () => {
    const onUnauthorized = vi.fn()
    window.addEventListener('auth:unauthorized', onUnauthorized)
    fetchMock.mockResolvedValueOnce(json({}, 500))

    await expect(apiGet('/api/devices')).rejects.toThrow()
    expect(onUnauthorized).not.toHaveBeenCalled()
    window.removeEventListener('auth:unauthorized', onUnauthorized)
  })

  it('apiSend posts JSON with a content-type and the auth header', async () => {
    setAuthToken('abc')
    fetchMock.mockResolvedValueOnce(json({ ok: true }, 201))

    const result = await apiSend('/api/sites', 'POST', { name: 'North' })

    expect(result).toEqual({ ok: true })
    const [, init] = lastCall()
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'North' }))
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer abc' })
  })

  it('apiSend rejects on a failed response', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 400))
    await expect(apiSend('/api/sites', 'PATCH', {})).rejects.toThrow('PATCH /api/sites failed')
  })

  it('apiGetText returns the raw body (used for the CSV export)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('a,b\n1,2\n', { status: 200 }))
    expect(await apiGetText('/api/devices/export')).toBe('a,b\n1,2\n')
  })

  it('apiDelete issues a DELETE and rejects on failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await apiDelete('/api/sites/1')
    expect(lastCall()[1].method).toBe('DELETE')

    fetchMock.mockResolvedValueOnce(json({}, 400))
    await expect(apiDelete('/api/sites/1')).rejects.toThrow('DELETE /api/sites/1 failed')
  })

  it('apiSendAgent surfaces the status and server message as an ApiRequestError', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'agents not configured' }, 503))

    const err = await apiSendAgent('/api/agents/alert-triage/run', {}).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiRequestError)
    expect((err as ApiRequestError).status).toBe(503)
    expect((err as ApiRequestError).message).toBe('agents not configured')
  })

  it('apiSendAgent falls back to a generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream exploded', { status: 502 }))

    const err = await apiSendAgent('/api/agents/alert-triage/run', {}).catch((e: unknown) => e)

    expect((err as ApiRequestError).status).toBe(502)
    expect((err as ApiRequestError).message).toBe('POST /api/agents/alert-triage/run failed')
  })
})
