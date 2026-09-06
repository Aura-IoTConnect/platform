export interface Vertical {
  id: string
  key: string
  name: string
  description: string
  deviceTypes: DeviceType[]
}

export type WidgetType = 'line-chart' | 'gauge' | 'stat-tile' | 'alarm-table' | 'svg-mimic'

export interface WidgetDef {
  type: WidgetType
  // Required for every type except 'alarm-table' (bound to the device
  // itself) and 'svg-mimic' (bound to many metrics via `bindings`).
  metricKey?: string
  label?: string
  // 'svg-mimic' only — see widgets/SvgMimicWidget.tsx
  svg?: string
  bindings?: {
    elementId: string
    metricKey: string
    mode: 'text' | 'fill' | 'visibility'
    thresholds?: { upTo?: number; color: string }[]
    unit?: string
  }[]
}

export interface DeviceType {
  id: string
  verticalId: string
  key: string
  name: string
  description: string
  metrics: {
    key: string
    label: string
    unit: string
    min?: number
    max?: number
    // Ingest-time policy, applied by apps/workers before persist/rule
    // evaluation — see CLAUDE.md's "Ingest-time metric pipeline".
    transform?: { type: 'linear'; factor?: number; offset?: number }
    onOutOfRange?: 'pass' | 'clamp' | 'reject'
    loggingMode?: 'always' | 'on-change'
    deadband?: number
  }[]
  vertical?: Vertical
  // Public lookup identifier for self-service device provisioning (see
  // CLAUDE.md) — null until an operator generates one. Never the secret
  // itself, which is only ever shown once, at generation time.
  provisionKey: string | null
  // Which widgets to render for this device type's detail view, and in what
  // order (see src/widgets/) — null/empty falls back to one line chart per
  // metric (DeviceDetail.tsx).
  defaultWidgets: WidgetDef[] | null
}

export interface Device {
  id: string
  name: string
  location: string | null
  status: 'ONLINE' | 'OFFLINE' | 'MAINTENANCE'
  createdAt: string
  deviceType: DeviceType & { vertical: Vertical }
}

export interface Alert {
  id: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  message: string
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
  createdAt: string
  resolvedAt: string | null
  device: Device
}

export interface Agent {
  id: string
  key: string
  name: string
  description: string
}

export interface AgentRun {
  id: string
  status: 'PENDING' | 'COMPLETED' | 'FAILED'
  input: unknown
  output: unknown
  createdAt: string
  agent: Agent
  alert: Alert | null
  feedback: { score: number; comment: string | null } | null
}

export interface Rule {
  id: string
  deviceTypeId: string
  name: string
  metric: string
  operator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ'
  threshold: number
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  actionType: 'notify' | 'webhook' | 'actuator'
  enabled: boolean
}

export interface BacktestResult {
  sinceHours: number
  devicesEvaluated: number
  readingsEvaluated: number
  breachingReadings: number
  estimatedEpisodes: number
  byDevice: {
    deviceId: string
    deviceName: string
    readings: number
    breaching: number
    episodes: number
    firstBreachAt: string | null
    lastBreachAt: string | null
  }[]
}

export interface BulkActuatorResult {
  deviceTypeId: string
  command: string
  dispatched: number
  failed: number
  results: { deviceId: string; deviceName: string; ok: boolean; status: number; data: unknown }[]
}

export interface WatchlistItem {
  id: string
  deviceId: string
  metricKey: string
  sortOrder: number
  createdAt: string
  device: Device
}
