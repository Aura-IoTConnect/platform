import { useEffect, useState } from 'react'
import { apiGet, apiSend } from '../api'
import type { ServiceLogEntry } from '../types'

// The serviceability record a technician would otherwise keep on paper or
// in a spreadsheet — a free-text, timestamped, per-device maintenance
// history. See CLAUDE.md's "Device lifecycle & service log" section.
export function ServiceLogPanel({ deviceId }: { deviceId: string }) {
  const [entries, setEntries] = useState<ServiceLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    apiGet<ServiceLogEntry[]>(`/api/devices/${deviceId}/service-log`)
      .then(setEntries)
      .catch(() => setError('Failed to load service log'))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [deviceId])

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!note.trim()) return
    setAdding(true)
    setError(null)
    try {
      await apiSend(`/api/devices/${deviceId}/service-log`, 'POST', { note })
      setNote('')
      load()
    } catch {
      setError('Failed to add service log entry')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="service-log-panel">
      <span className="widget-label">Service log</span>
      <form onSubmit={addNote} className="device-form">
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Replaced desiccant pack" />
        <button type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add note'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="hint">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="hint">No service history yet.</p>
      ) : (
        <ul className="record-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="record-main">
                <span className="record-title">{entry.note}</span>
                <span className="record-subtitle">
                  {entry.createdBy ?? 'unknown'} · {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
