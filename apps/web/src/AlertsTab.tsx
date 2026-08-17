import { useEffect, useState } from 'react'
import { apiGet, apiSend, WorkersRequestError, workersPost } from './api'
import type { Alert } from './types'

function agentErrorMessage(err: unknown): string {
  if (err instanceof WorkersRequestError && err.status === 503) {
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

  const load = () => {
    setLoading(true)
    apiGet<Alert[]>('/api/alerts')
      .then(setAlerts)
      .catch(() => setError('Failed to load alerts'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

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
      await workersPost('/agents/anomaly-explainer/run', { alert_id: alertId })
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
      await workersPost('/agents/alert-triage/run', {})
      setAgentNotice('Triage complete — see the ranking in the Agent Runs tab.')
    } catch (err) {
      setAgentNotice(agentErrorMessage(err))
    } finally {
      setPendingAgentId(null)
    }
  }

  return (
    <section>
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
