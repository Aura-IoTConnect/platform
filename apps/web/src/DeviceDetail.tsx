import { useEffect, useState } from 'react'
import { apiGet, apiSendAgent, ApiRequestError } from './api'
import { LineChart } from './LineChart'
import type { Device } from './types'

interface Reading {
  id: string
  metric: string
  value: number
  unit: string | null
  timestamp: string
}

function agentErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 503) {
    return 'AI agents are not configured (ANTHROPIC_API_KEY missing in apps/workers/.env).'
  }
  return 'Agent request failed — is apps/workers running?'
}

export function DeviceDetail({ device, onClose }: { device: Device; onClose: () => void }) {
  const [readings, setReadings] = useState<Reading[]>([])
  const [loading, setLoading] = useState(true)
  const [suggesting, setSuggesting] = useState(false)
  const [agentNotice, setAgentNotice] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    apiGet<Reading[]>(`/api/telemetry?deviceId=${device.id}&limit=50`)
      .then(setReadings)
      .finally(() => setLoading(false))
  }, [device.id])

  const byMetric = new Map<string, Reading[]>()
  for (const r of readings) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, [])
    byMetric.get(r.metric)!.push(r)
  }
  for (const list of byMetric.values()) list.reverse() // API returns newest-first; charts read left-to-right in time

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

  return (
    <div className="device-detail">
      <div className="device-detail-header">
        <h3>{device.name}</h3>
        <div className="record-actions">
          <button type="button" onClick={suggestAutomation} disabled={suggesting}>
            {suggesting ? 'Thinking…' : 'Suggest automation'}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {agentNotice && <p className="hint">{agentNotice}</p>}

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
