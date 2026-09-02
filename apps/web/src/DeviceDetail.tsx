import { useEffect, useState } from 'react'
import { apiDelete, apiGet, apiSend, apiSendAgent, ApiRequestError } from './api'
import { LineChart } from './LineChart'
import type { Device } from './types'

interface Reading {
  id: string
  metric: string
  value: number
  unit: string | null
  timestamp: string
}

interface ActuatorCommand {
  id: string
  command: string
  value: unknown
  source: 'RULE' | 'MANUAL'
  createdAt: string
  rule: { name: string } | null
}

function agentErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 503) {
    return 'AI agents are not configured (ANTHROPIC_API_KEY missing in apps/workers/.env).'
  }
  return 'Agent request failed — is apps/workers running?'
}

export function DeviceDetail({
  device,
  onClose,
  onDeleted,
}: {
  device: Device
  onClose: () => void
  onDeleted: () => void
}) {
  const [readings, setReadings] = useState<Reading[]>([])
  const [loading, setLoading] = useState(true)
  const [suggesting, setSuggesting] = useState(false)
  const [agentNotice, setAgentNotice] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [commands, setCommands] = useState<ActuatorCommand[]>([])
  const [commandName, setCommandName] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const [sending, setSending] = useState(false)
  const [actuatorError, setActuatorError] = useState<string | null>(null)

  const loadCommands = () => {
    apiGet<ActuatorCommand[]>(`/api/actuator-commands?deviceId=${device.id}&limit=10`)
      .then(setCommands)
      .catch(() => {})
  }

  useEffect(() => {
    setLoading(true)
    apiGet<Reading[]>(`/api/telemetry?deviceId=${device.id}&limit=50`)
      .then(setReadings)
      .finally(() => setLoading(false))
    loadCommands()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  const byMetric = new Map<string, Reading[]>()
  for (const r of readings) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, [])
    byMetric.get(r.metric)!.push(r)
  }
  for (const list of byMetric.values()) list.reverse() // API returns newest-first; charts read left-to-right in time

  const rotateKey = async () => {
    setRotating(true)
    try {
      const res = await apiSend<{ apiKey: string }>(`/api/devices/${device.id}/rotate-key`, 'POST', {})
      setNewApiKey(res.apiKey)
    } catch {
      setAgentNotice('Failed to rotate API key.')
    } finally {
      setRotating(false)
    }
  }

  const deleteDevice = async () => {
    if (!window.confirm(`Delete ${device.name}? Its telemetry/alert/command history is kept, but it disappears from the dashboard.`)) {
      return
    }
    setDeleting(true)
    try {
      await apiDelete(`/api/devices/${device.id}`)
      onDeleted()
    } catch {
      setAgentNotice('Failed to delete device.')
      setDeleting(false)
    }
  }

  const suggestAutomation = async () => {
    setAgentNotice(null)
    setSuggesting(true)
    try {
      await apiSendAgent('/api/agents/automation-suggester/run', { deviceTypeId: device.deviceType.id })
      setAgentNotice('Suggestions generated — see them in the Agent Runs tab.')
    } catch (err) {
      setAgentNotice(agentErrorMessage(err))
    } finally {
      setSuggesting(false)
    }
  }

  const sendCommand = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!commandName.trim()) return

    setActuatorError(null)
    setSending(true)
    try {
      await apiSend(`/api/devices/${device.id}/actuator`, 'POST', {
        command: commandName,
        value: commandValue || undefined,
      })
      setCommandName('')
      setCommandValue('')
      loadCommands()
    } catch {
      setActuatorError('Failed to send command — is apps/workers running?')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="device-detail">
      <div className="device-detail-header">
        <h3>{device.name}</h3>
        <div className="record-actions">
          <button type="button" onClick={rotateKey} disabled={rotating}>
            {rotating ? 'Rotating…' : 'Rotate API key'}
          </button>
          <button type="button" onClick={suggestAutomation} disabled={suggesting}>
            {suggesting ? 'Thinking…' : 'Suggest automation'}
          </button>
          <button type="button" onClick={deleteDevice} disabled={deleting} className="danger-button">
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {agentNotice && <p className="hint">{agentNotice}</p>}

      {newApiKey && (
        <div className="api-key-banner">
          <p>New API key — save it now, it won't be shown again (the old key stops working immediately):</p>
          <code>{newApiKey}</code>
          <button type="button" onClick={() => setNewApiKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="actuator-panel">
        <form onSubmit={sendCommand} className="device-form">
          <input
            type="text"
            value={commandName}
            onChange={(e) => setCommandName(e.target.value)}
            placeholder="Command (e.g. turn_on_fan)"
          />
          <input
            type="text"
            value={commandValue}
            onChange={(e) => setCommandValue(e.target.value)}
            placeholder="Value (optional)"
          />
          <button type="submit" disabled={sending}>
            {sending ? 'Sending…' : 'Send command'}
          </button>
        </form>

        {actuatorError && <p className="error">{actuatorError}</p>}

        {commands.length > 0 && (
          <ul className="record-list">
            {commands.map((c) => (
              <li key={c.id}>
                <div className="record-main">
                  <span className="record-title">{c.command}</span>
                  <span className="record-subtitle">
                    {c.source === 'RULE' && c.rule ? `rule: ${c.rule.name}` : 'manual'} ·{' '}
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                </div>
                <span className={`status-pill status-${c.source === 'RULE' ? 'acknowledged' : 'online'}`}>
                  {c.source}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : byMetric.size === 0 ? (
        <p className="hint">No telemetry yet for this device.</p>
      ) : (
        Array.from(byMetric.entries()).map(([metric, points]) => {
          const meta = device.deviceType.metrics.find((m) => m.key === metric)
          const latest = points[points.length - 1]
          return (
            <div key={metric} className="metric-chart">
              <div className="metric-chart-header">
                <span>{meta?.label ?? metric}</span>
                <span className="record-subtitle">
                  {latest.value}
                  {meta?.unit ? ` ${meta.unit}` : ''}
                </span>
              </div>
              <LineChart points={points} />
            </div>
          )
        })
      )}
    </div>
  )
}
