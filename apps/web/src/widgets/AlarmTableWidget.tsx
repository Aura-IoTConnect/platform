import { useEffect, useState } from 'react'
import { apiGet } from '../api'
import type { Alert } from '../types'

export function AlarmTableWidget({ deviceId }: { deviceId: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiGet<Alert[]>(`/api/alerts?deviceId=${deviceId}`)
      .then((all) => setAlerts(all.slice(0, 5)))
      .finally(() => setLoading(false))
  }, [deviceId])

  return (
    <div className="widget alarm-table-widget">
      <span className="widget-label">Recent alerts</span>
      {loading ? (
        <p className="hint">Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="hint">No alerts for this device.</p>
      ) : (
        <ul className="record-list">
          {alerts.map((a) => (
            <li key={a.id}>
              <div className="record-main">
                <span className="record-title">{a.message}</span>
                <span className="record-subtitle">{new Date(a.createdAt).toLocaleString()}</span>
              </div>
              <span className={`status-pill status-${a.status.toLowerCase()}`}>{a.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
