import { useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiGetText, apiSend } from './api'
import { DeviceDetail } from './DeviceDetail'
import { livenessBadgeText, livenessLabel, livenessState } from './liveness'
import { SitesManager } from './SitesManager'
import type { Device, DeviceImportResult, Vertical } from './types'

type StatusFilter = 'ALL' | Device['status']
type SortBy = 'created' | 'name' | 'status' | 'lastSeenAt'

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
  const [newProvisioningSecret, setNewProvisioningSecret] = useState<{
    provisionKey: string
    provisionSecret: string
  } | null>(null)
  const [importResult, setImportResult] = useState<DeviceImportResult | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Search/filter/sort — client-side over the already-fetched device list
  // (small fleets, no pagination anywhere else in this dashboard either).
  // See CLAUDE.md's "Liveness signal & Devices tab search" section.
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [sortBy, setSortBy] = useState<SortBy>('created')

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

  const handleGenerateProvisioningSecret = async () => {
    if (!deviceTypeId) return
    setError(null)
    try {
      const secret = await apiSend<{ provisionKey: string; provisionSecret: string }>(
        `/api/device-types/${deviceTypeId}/provisioning-secret`,
        'POST',
        undefined,
      )
      setNewProvisioningSecret(secret)
      load()
    } catch {
      setError('Failed to generate provisioning secret')
    }
  }

  // CSV export/import — a second onboarding/reporting path alongside the
  // one-at-a-time form above and self-service provisioning. See CLAUDE.md's
  // "Grouping, tags & bulk import/export" section.
  const handleExport = async () => {
    setError(null)
    try {
      const csv = await apiGetText('/api/devices/export')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'devices.csv'
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Failed to export devices')
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setImporting(true)
    setImportResult(null)
    try {
      const csv = await file.text()
      const result = await apiSend<DeviceImportResult>('/api/devices/import', 'POST', { csv })
      setImportResult(result)
      load()
    } catch {
      setError('Failed to import devices')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const visibleDevices = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = devices.filter((d) => {
      if (statusFilter !== 'ALL' && d.status !== statusFilter) return false
      if (!needle) return true
      const haystack = [
        d.name,
        d.location ?? '',
        d.deviceType.name,
        d.deviceType.vertical.name,
        d.site?.name ?? '',
        ...d.tags,
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })

    const sorted = [...filtered]
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    } else if (sortBy === 'status') {
      sorted.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name))
    } else if (sortBy === 'lastSeenAt') {
      // Most-recently-seen first; devices that have never reported sort last.
      sorted.sort((a, b) => {
        if (!a.lastSeenAt && !b.lastSeenAt) return a.name.localeCompare(b.name)
        if (!a.lastSeenAt) return 1
        if (!b.lastSeenAt) return -1
        return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      })
    }
    // 'created' needs no client-side sort — GET /api/devices already
    // returns newest-first.
    return sorted
  }, [devices, search, statusFilter, sortBy])

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null
  const selectedDeviceType = verticals
    .flatMap((v) => v.deviceTypes)
    .find((dt) => dt.id === deviceTypeId)

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

      <div className="device-form">
        <button type="button" onClick={handleExport}>
          Export CSV
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing}>
          {importing ? 'Importing…' : 'Import CSV'}
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleImportFile} hidden />
        <SitesManager />
      </div>

      {importResult && (
        <div className="api-key-banner">
          <p>
            Import finished — <strong>{importResult.created}</strong> created
            {importResult.failed > 0 ? `, ${importResult.failed} failed` : ''}.
          </p>
          {importResult.failed > 0 && (
            <ul className="record-list">
              {importResult.results
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.row}>
                    <span className="record-title">Row {r.row}</span>
                    <span className="record-subtitle">{r.error}</span>
                  </li>
                ))}
            </ul>
          )}
          <button type="button" onClick={() => setImportResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      {selectedDeviceType && (
        <p className="hint">
          {selectedDeviceType.provisionKey ? (
            <>
              Self-service provisioning is on for <strong>{selectedDeviceType.name}</strong> — devices of this type
              can create themselves via <code>POST /ingestion/provision</code>.{' '}
            </>
          ) : (
            <>
              <strong>{selectedDeviceType.name}</strong> has no self-service provisioning credential yet.{' '}
            </>
          )}
          <button type="button" onClick={handleGenerateProvisioningSecret} style={{ marginLeft: '0.4rem' }}>
            {selectedDeviceType.provisionKey ? 'Rotate provisioning key' : 'Generate provisioning key'}
          </button>
        </p>
      )}

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

      {newProvisioningSecret && (
        <div className="api-key-banner">
          <p>
            Provisioning credential — save it now, the secret won't be shown again. A device presents both to{' '}
            <code>POST /ingestion/provision</code> to create itself:
          </p>
          <p>
            provisionKey: <code>{newProvisioningSecret.provisionKey}</code>
          </p>
          <p>
            provisionSecret: <code>{newProvisioningSecret.provisionSecret}</code>
          </p>
          <button type="button" onClick={() => setNewProvisioningSecret(null)}>
            Dismiss
          </button>
        </div>
      )}

      {selectedDevice && (
        <DeviceDetail
          device={selectedDevice}
          allDevices={devices}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}

      <div className="device-form devices-toolbar">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, location, type, tag, site…"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
          <option value="ALL">All statuses</option>
          <option value="ONLINE">Online</option>
          <option value="OFFLINE">Offline</option>
          <option value="MAINTENANCE">Maintenance</option>
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
          <option value="created">Newest first</option>
          <option value="name">Name</option>
          <option value="status">Status</option>
          <option value="lastSeenAt">Last seen</option>
        </select>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : devices.length === 0 ? (
        <p>No devices yet.</p>
      ) : visibleDevices.length === 0 ? (
        <p className="hint">No devices match your search/filter.</p>
      ) : (
        <ul className="record-list">
          {visibleDevices.map((device) => (
            <li key={device.id} className="clickable" onClick={() => setSelectedId(device.id)}>
              <div className="record-main">
                <span className="record-title">{device.name}</span>
                <span className="record-subtitle">
                  {device.deviceType.vertical.name} · {device.deviceType.name}
                  {device.location ? ` · ${device.location}` : ''}
                  {device.site ? ` · ${device.site.name}` : ''}
                  {device.childDevices.length > 0
                    ? ` · gateway (${device.childDevices.length} device${device.childDevices.length === 1 ? '' : 's'})`
                    : ''}
                  {device.parentDeviceId ? ' · sub-device' : ''}
                </span>
                {device.tags.length > 0 && (
                  <div className="tag-list">
                    {device.tags.map((tag) => (
                      <span key={tag} className="tag-chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="record-actions-column">
                <span className={`status-pill status-${device.status.toLowerCase()}`}>{device.status}</span>
                <span
                  className={`liveness-pill liveness-${livenessState(device.lastSeenAt)}`}
                  title={livenessLabel(device.lastSeenAt)}
                >
                  {livenessBadgeText(device.lastSeenAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
