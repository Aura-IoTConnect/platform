import { useEffect, useRef, useState } from 'react'
import { apiGet, apiSend, apiSendAgent, ApiRequestError } from './api'
import type { Alert } from './types'

const POLL_MS = 15_000

// Short two-tone beep via WebAudio — no asset to ship. Browsers gate audio
// behind a prior user gesture; if none has happened yet this silently
// no-ops and the flashing banner still does its job.
function beep() {
  try {
    const ctx = new AudioContext()
    const play = (freq: number, at: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.25)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + at)
      osc.stop(ctx.currentTime + at + 0.3)
    }
    play(880, 0)
    play(660, 0.3)
    setTimeout(() => ctx.close().catch(() => {}), 1000)
  } catch {
    /* autoplay blocked or no AudioContext — banner only */
  }
}

function agentErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 503) {
    return 'AI agents are not configured (ANTHROPIC_API_KEY missing in apps/workers/.env).'
  }
  return 'Agent request failed — is apps/workers running?'
}

export function AlertsTab() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null)
  const [agentNotice, setAgentNotice] = useState<string | null>(null)
  // New CRITICAL/OPEN alerts since the previous poll — the SCADA-style
  // "alarm horn": a flashing banner plus a short beep until dismissed.
  // See CLAUDE.md, Alerts tab.
  const [newCritical, setNewCritical] = useState<Alert[]>([])
  const seenCriticalIds = useRef<Set<string> | null>(null)

  const load = (background = false) => {
    if (!background) setLoading(true)
    apiGet<Alert[]>('/api/alerts')
      .then((list) => {
        setAlerts(list)
        const critical = list.filter((a) => a.severity === 'CRITICAL' && a.status === 'OPEN')
        if (seenCriticalIds.current === null) {
          // First load: baseline, don't alarm on history.
          seenCriticalIds.current = new Set(critical.map((a) => a.id))
        } else {
          const fresh = critical.filter((a) => !seenCriticalIds.current!.has(a.id))
          if (fresh.length > 0) {
            fresh.forEach((a) => seenCriticalIds.current!.add(a.id))
            setNewCritical((prev) => [...fresh, ...prev])
            beep()
          }
        }
      })
      .catch(() => setError('Failed to load alerts'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const timer = setInterval(() => load(true), POLL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateStatus = async (id: string, status: Alert['status']) => {
    try {
      await apiSend(`/api/alerts/${id}`, 'PATCH', { status })
      load()
    } catch {
      setError('Failed to update alert')
    }
  }

  const explainAlert = async (alertId: string) => {
    setAgentNotice(null)
    setPendingAgentId(alertId)
    try {
      await apiSendAgent('/api/agents/anomaly-explainer/run', { alertId })
      setAgentNotice('Explanation generated — see it in the Agent Runs tab.')
    } catch (err) {
      setAgentNotice(agentErrorMessage(err))
    } finally {
      setPendingAgentId(null)
    }
  }

  const triageAlerts = async () => {
    setAgentNotice(null)
    setPendingAgentId('triage')
    try {
      await apiSendAgent('/api/agents/alert-triage/run', {})
      setAgentNotice('Triage complete — see the ranking in the Agent Runs tab.')
    } catch (err) {
      setAgentNotice(agentErrorMessage(err))
    } finally {
      setPendingAgentId(null)
    }
  }

  return (
    <section>
      {newCritical.length > 0 && (
        <div className="critical-banner" role="alert">
          <div className="record-main">
            <strong>
              {newCritical.length} new critical alert{newCritical.length === 1 ? '' : 's'}
            </strong>
            {newCritical.map((a) => (
              <span key={a.id} className="record-subtitle">
                {a.device.name} — {a.message}
              </span>
            ))}
          </div>
          <div className="record-actions">
            <button type="button" onClick={() => setNewCritical([])}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {alerts.some((a) => a.status === 'OPEN') && (
        <div className="agent-toolbar">
          <button type="button" onClick={triageAlerts} disabled={pendingAgentId === 'triage'}>
            {pendingAgentId === 'triage' ? 'Triaging…' : 'Triage open alerts'}
          </button>
          {agentNotice && <span className="hint">{agentNotice}</span>}
        </div>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : alerts.length === 0 ? (
        <p>No alerts.</p>
      ) : (
        <ul className="record-list">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <div className="record-main">
                <span className="record-title">
                  <span className={`severity-dot severity-${alert.severity.toLowerCase()}`} />
                  {alert.message}
                </span>
                <span className="record-subtitle">
                  {alert.device.name} · {new Date(alert.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="record-actions">
                <span className={`status-pill status-${alert.status.toLowerCase()}`}>{alert.status}</span>
                <button
                  type="button"
                  onClick={() => explainAlert(alert.id)}
                  disabled={pendingAgentId === alert.id}
                >
                  {pendingAgentId === alert.id ? 'Explaining…' : 'Explain'}
                </button>
                {alert.status === 'OPEN' && (
                  <button type="button" onClick={() => updateStatus(alert.id, 'ACKNOWLEDGED')}>
                    Acknowledge
                  </button>
                )}
                {alert.status !== 'RESOLVED' && (
                  <button type="button" onClick={() => updateStatus(alert.id, 'RESOLVED')}>
                    Resolve
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
