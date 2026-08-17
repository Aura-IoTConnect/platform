import { useEffect, useState } from 'react'
import { apiGet, apiSend } from './api'
import { DeviceDetail } from './DeviceDetail'
import type { Device, Vertical } from './types'

export function DevicesTab() {
  const [devices, setDevices] = useState<Device[]>([])
  const [verticals, setVerticals] = useState<Vertical[]>([])
  const [name, setName] = useState('')
  const [deviceTypeId, setDeviceTypeId] = useState('')
  const [location, setLocation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newApiKey, setNewApiKey] = useState<{ deviceName: string; apiKey: string } | null>(null)

  const load = () => {
    setLoading(true)
    Promise.all([apiGet<Device[]>('/api/devices'), apiGet<Vertical[]>('/api/verticals')])
      .then(([d, v]) => {
        setDevices(d)
        setVerticals(v)
        if (!deviceTypeId && v[0]?.deviceTypes[0]) {
          setDeviceTypeId(v[0].deviceTypes[0].id)
        }
      })
      .catch(() => setError('Failed to load devices'))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !deviceTypeId) return

    setError(null)
    try {
      const created = await apiSend<{ name: string; apiKey: string }>('/api/devices', 'POST', {
        name,
        deviceTypeId,
        location: location || undefined,
      })
      setNewApiKey({ deviceName: created.name, apiKey: created.apiKey })
      setName('')
      setLocation('')
      load()
    } catch {
      setError('Failed to create device')
    }
  }

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null

  return (
    <section>
      <form onSubmit={handleSubmit} className="device-form">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Device name"
        />
        <select value={deviceTypeId} onChange={(e) => setDeviceTypeId(e.target.value)}>
          {verticals.map((vertical) => (
            <optgroup key={vertical.id} label={vertical.name}>
              {vertical.deviceTypes.map((dt) => (
                <option key={dt.id} value={dt.id}>
                  {dt.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location (optional)"
        />
        <button type="submit">Add device</button>
      </form>

      {error && <p className="error">{error}</p>}

      {newApiKey && (
        <div className="api-key-banner">
          <p>
            API key for <strong>{newApiKey.deviceName}</strong> — save it now, it won't be shown again:
          </p>
          <code>{newApiKey.apiKey}</code>
          <button type="button" onClick={() => setNewApiKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      {selectedDevice && <DeviceDetail device={selectedDevice} onClose={() => setSelectedId(null)} />}

      {loading ? (
        <p>Loading…</p>
      ) : devices.length === 0 ? (
        <p>No devices yet.</p>
      ) : (
        <ul className="record-list">
          {devices.map((device) => (
            <li key={device.id} className="clickable" onClick={() => setSelectedId(device.id)}>
              <div className="record-main">
                <span className="record-title">{device.name}</span>
                <span className="record-subtitle">
                  {device.deviceType.vertical.name} · {device.deviceType.name}
                  {device.location ? ` · ${device.location}` : ''}
                </span>
              </div>
              <span className={`status-pill status-${device.status.toLowerCase()}`}>{device.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
