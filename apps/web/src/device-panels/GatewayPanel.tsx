import { useState } from 'react'
import { apiSend } from '../api'
import type { Device } from '../types'

// Gateway/child hierarchy is one level only (see CLAUDE.md): a device that
// already has children can't become a child, and a device that already has
// a parent can't become a gateway — enforced server-side in PATCH
// /api/devices/:id; this panel just hides the actions that would be
// rejected rather than duplicating the rule client-side.
export function GatewayPanel({
  device,
  allDevices,
  onChanged,
}: {
  device: Device
  allDevices: Device[]
  onChanged: () => void
}) {
  const [attachTargetId, setAttachTargetId] = useState('')
  const [childTargetId, setChildTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setParent = async (parentDeviceId: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await apiSend<Device>(`/api/devices/${device.id}`, 'PATCH', { parentDeviceId })
      onChanged()
    } catch {
      setError('Failed to update gateway assignment')
    } finally {
      setBusy(false)
    }
  }

  const detachChild = async (childId: string) => {
    setBusy(true)
    setError(null)
    try {
      await apiSend<Device>(`/api/devices/${childId}`, 'PATCH', { parentDeviceId: null })
      onChanged()
    } catch {
      setError('Failed to detach child device')
    } finally {
      setBusy(false)
    }
  }

  const attachChild = async () => {
    if (!childTargetId) return
    setBusy(true)
    setError(null)
    try {
      await apiSend<Device>(`/api/devices/${childTargetId}`, 'PATCH', { parentDeviceId: device.id })
      setChildTargetId('')
      onChanged()
    } catch {
      setError('Failed to attach child device')
    } finally {
      setBusy(false)
    }
  }

  const parentDevice = device.parentDeviceId ? allDevices.find((d) => d.id === device.parentDeviceId) : null
  const isChild = device.parentDeviceId !== null
  const isGateway = device.childDevices.length > 0

  // Candidates for "attach to gateway": any other device without a parent of
  // its own (a device already someone's child can't itself be a gateway).
  const parentCandidates = allDevices.filter((d) => d.id !== device.id && d.parentDeviceId === null)
  // Candidates for "add child": any other device with neither a parent nor
  // children of its own — the one-level-only constraint from both directions.
  const childCandidates = allDevices.filter(
    (d) => d.id !== device.id && d.parentDeviceId === null && d.childDevices.length === 0,
  )

  return (
    <div className="gateway-panel">
      <span className="widget-label">Gateway hierarchy</span>

      {isChild && (
        <p>
          Attached to gateway <strong>{parentDevice?.name ?? device.parentDeviceId}</strong>{' '}
          <button type="button" onClick={() => setParent(null)} disabled={busy}>
            Detach
          </button>
        </p>
      )}

      {!isChild && !isGateway && (
        <div className="device-form">
          <select value={attachTargetId} onChange={(e) => setAttachTargetId(e.target.value)}>
            <option value="">Attach to gateway…</option>
            {parentCandidates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => attachTargetId && setParent(attachTargetId)}
            disabled={busy || !attachTargetId}
          >
            Attach
          </button>
        </div>
      )}

      {isGateway && (
        <ul className="record-list">
          {device.childDevices.map((child) => (
            <li key={child.id}>
              <div className="record-main">
                <span className="record-title">{child.name}</span>
              </div>
              <span className={`status-pill status-${child.status.toLowerCase()}`}>{child.status}</span>
              <button type="button" onClick={() => detachChild(child.id)} disabled={busy}>
                Detach
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isChild && (
        <div className="device-form">
          <select value={childTargetId} onChange={(e) => setChildTargetId(e.target.value)}>
            <option value="">Add child device…</option>
            {childCandidates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={attachChild} disabled={busy || !childTargetId}>
            Add
          </button>
        </div>
      )}

      {!isChild && !isGateway && parentCandidates.length === 0 && childCandidates.length === 0 && (
        <p className="hint">No other devices available to link yet.</p>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  )
}
