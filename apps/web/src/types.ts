export interface Vertical {
  id: string
  key: string
  name: string
  description: string
  deviceTypes: DeviceType[]
}

export interface DeviceType {
  id: string
  verticalId: string
  key: string
  name: string
  description: string
  metrics: { key: string; label: string; unit: string; min?: number; max?: number }[]
  vertical?: Vertical
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
