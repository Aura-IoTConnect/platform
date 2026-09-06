import { useEffect, useState } from 'react'
import { apiDelete, apiGet, apiSend } from './api'
import type { Device, WatchlistItem } from './types'
import { LineChartWidget } from './widgets/LineChartWidget'
import { StatTile } from './widgets/StatTile'

interface Reading {
  metric: string
  value: number
  timestamp: string
}

// An operator's own, freely-mixed pins across devices and device types —
// distinct from DeviceType.defaultWidgets (an admin-authored per-type
// template). Mined from ScadaBR's Watch List. See CLAUDE.md.
export function WatchlistTab() {
  const [items, setItems] = useState<WatchlistItem[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [metricKey, setMetricKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    Promise.all([apiGet<WatchlistItem[]>('/api/watchlist'), apiGet<Device[]>('/api/devices')])
      .then(([w, d]) => {
        setItems(w)
        setDevices(d)
        if (!deviceId && d[0]) setDeviceId(d[0].id)
      })
      .catch(() => setError('Failed to load watchlist'))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  const selectedDevice = devices.find((d) => d.id === deviceId)
  const metricOptions = selectedDevice?.deviceType.metrics ?? []
  const effectiveMetricKey = metricOptions.some((m) => m.key === metricKey) ? metricKey : (metricOptions[0]?.key ?? '')

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!deviceId || !effectiveMetricKey) return
    setError(null)
    try {
      await apiSend('/api/watchlist', 'POST', { deviceId, metricKey: effectiveMetricKey })
      load()
    } catch {
      setError('Failed to add — is it already on your watchlist?')
    }
  }

  const remove = async (id: string) => {
    setError(null)
    try {
      await apiDelete(`/api/watchlist/${id}`)
      setItems((list) => list.filter((i) => i.id !== id))
    } catch {
      setError('Failed to remove item')
    }
  }

  return (
    <section>
      <form onSubmit={add} className="device-form">
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.deviceType.name}
            </option>
          ))}
        </select>
        <select value={effectiveMetricKey} onChange={(e) => setMetricKey(e.target.value)}>
          {metricOptions.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!deviceId || !effectiveMetricKey}>
          Pin to watchlist
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="hint">Nothing pinned yet — pick any device and metric above.</p>
      ) : (
        <div className="watchlist">
          {items.map((item) => (
            <WatchlistCard key={item.id} item={item} onRemove={() => remove(item.id)} />
          ))}
        </div>
      )}
    </section>
  )
}

function WatchlistCard({ item, onRemove }: { item: WatchlistItem; onRemove: () => void }) {
  const [points, setPoints] = useState<Reading[]>([])
  const meta = item.device.deviceType.metrics.find((m) => m.key === item.metricKey)
  const label = meta?.label ?? item.metricKey

  useEffect(() => {
    apiGet<Reading[]>(`/api/telemetry?deviceId=${item.deviceId}&limit=100`)
      .then((all) => setPoints(all.filter((r) => r.metric === item.metricKey).reverse()))
      .catch(() => {})
  }, [item.deviceId, item.metricKey])

  const latest = points[points.length - 1]
  return (
    <div className="watchlist-card">
      <div className="watchlist-card-header">
        <span className="record-title">
          {item.device.name}
          <span className="record-subtitle">· {item.device.deviceType.name}</span>
        </span>
        <div className="record-actions">
          <button type="button" onClick={onRemove}>
            Unpin
          </button>
        </div>
      </div>
      {latest ? (
        <div className="widget-grid">
          <StatTile label={label} value={latest.value} unit={meta?.unit} />
          <LineChartWidget label={label} unit={meta?.unit} points={points} />
        </div>
      ) : (
        <p className="hint">No {label} readings yet.</p>
      )}
      {latest && <span className="record-subtitle">last update {new Date(latest.timestamp).toLocaleString()}</span>}
    </div>
  )
}
