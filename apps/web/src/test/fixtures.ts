import type { Device, Vertical } from '../types'

const vertical: Vertical = {
  id: 'v1',
  key: 'cold-storage',
  name: 'Cold Storage',
  description: 'test vertical',
  deviceTypes: [],
}

const deviceType: Device['deviceType'] = {
  id: 'dt1',
  verticalId: 'v1',
  key: 'chiller',
  name: 'Chiller',
  description: 'test device type',
  metrics: [],
  provisionKey: null,
  defaultWidgets: null,
  vertical,
}

vertical.deviceTypes = [deviceType]

export { vertical, deviceType }

// A complete Device with every optional field at its "nothing recorded"
// value, so a test only states what it cares about.
export function makeDevice(overrides: Partial<Device> & Pick<Device, 'id' | 'name'>): Device {
  return {
    location: null,
    status: 'ONLINE',
    createdAt: '2026-01-01T00:00:00.000Z',
    deviceType,
    firmwareVersion: null,
    hardwareModel: null,
    manufacturer: null,
    commissionedAt: null,
    warrantyExpiresAt: null,
    parentDeviceId: null,
    childDevices: [],
    tags: [],
    siteId: null,
    site: null,
    lastSeenAt: null,
    ...overrides,
  }
}
