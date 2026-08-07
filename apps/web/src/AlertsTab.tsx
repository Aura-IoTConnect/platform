import { useEffect, useState } from 'react'
import { apiGet, apiSend } from './api'
import type { Alert } from './types'

export function AlertsTab() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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

  return (
    <section>
      {error && <p className="error">{error}</p>}

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
