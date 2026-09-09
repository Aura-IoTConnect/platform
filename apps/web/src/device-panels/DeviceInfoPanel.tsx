import { useState } from 'react'
import { apiSend } from '../api'
import type { Device } from '../types'

// Lifecycle/serviceability metadata (firmware/hardware/manufacturer,
// commissioning + warranty dates) — set post-creation via PATCH
// /api/devices/:id, since a device is rarely commissioned with a known
// firmware version/warranty date at the exact moment its row is created.
// See CLAUDE.md's "Device lifecycle & service log" section.
export function DeviceInfoPanel({ device: initialDevice }: { device: Device }) {
  const [device, setDevice] = useState(initialDevice)
  const [editing, setEditing] = useState(false)
  const [firmwareVersion, setFirmwareVersion] = useState(device.firmwareVersion ?? '')
  const [hardwareModel, setHardwareModel] = useState(device.hardwareModel ?? '')
  const [manufacturer, setManufacturer] = useState(device.manufacturer ?? '')
  const [commissionedAt, setCommissionedAt] = useState(device.commissionedAt?.slice(0, 10) ?? '')
  const [warrantyExpiresAt, setWarrantyExpiresAt] = useState(device.warrantyExpiresAt?.slice(0, 10) ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await apiSend<Device>(`/api/devices/${device.id}`, 'PATCH', {
        firmwareVersion: firmwareVersion || null,
        hardwareModel: hardwareModel || null,
        manufacturer: manufacturer || null,
        commissionedAt: commissionedAt || null,
        warrantyExpiresAt: warrantyExpiresAt || null,
      })
      setDevice(updated)
      setEditing(false)
    } catch {
      setError('Failed to save device info')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    const hasAny =
      device.manufacturer || device.hardwareModel || device.firmwareVersion || device.commissionedAt || device.warrantyExpiresAt
    return (
      <div className="device-info-panel">
        <div className="device-info-header">
          <span className="widget-label">Device info</span>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        {hasAny ? (
          <dl className="device-info-grid">
            {device.manufacturer && (
              <>
                <dt>Manufacturer</dt>
                <dd>{device.manufacturer}</dd>
              </>
            )}
            {device.hardwareModel && (
              <>
                <dt>Hardware model</dt>
                <dd>{device.hardwareModel}</dd>
              </>
            )}
            {device.firmwareVersion && (
              <>
                <dt>Firmware</dt>
                <dd>{device.firmwareVersion}</dd>
              </>
            )}
            {device.commissionedAt && (
              <>
                <dt>Commissioned</dt>
                <dd>{new Date(device.commissionedAt).toLocaleDateString()}</dd>
              </>
            )}
            {device.warrantyExpiresAt && (
              <>
                <dt>Warranty until</dt>
                <dd>{new Date(device.warrantyExpiresAt).toLocaleDateString()}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="hint">No lifecycle info recorded yet.</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    <form onSubmit={save} className="device-form device-info-form">
      <input type="text" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Manufacturer" />
      <input
        type="text"
        value={hardwareModel}
        onChange={(e) => setHardwareModel(e.target.value)}
        placeholder="Hardware model"
      />
      <input
        type="text"
        value={firmwareVersion}
        onChange={(e) => setFirmwareVersion(e.target.value)}
        placeholder="Firmware version"
      />
      <label className="device-info-date-label">
        Commissioned
        <input type="date" value={commissionedAt} onChange={(e) => setCommissionedAt(e.target.value)} />
      </label>
      <label className="device-info-date-label">
        Warranty until
        <input type="date" value={warrantyExpiresAt} onChange={(e) => setWarrantyExpiresAt(e.target.value)} />
      </label>
      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={() => setEditing(false)} disabled={saving}>
        Cancel
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
