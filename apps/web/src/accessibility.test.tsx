import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRunsTab } from './AgentRunsTab'
import { DevicesTab } from './DevicesTab'
import { LineChart } from './LineChart'
import { Login } from './Login'
import { makeDevice, vertical } from './test/fixtures'
import { GaugeWidget } from './widgets/GaugeWidget'
import type { AgentRun } from './types'

vi.mock('./api', () => ({
  apiGet: vi.fn(),
  apiGetText: vi.fn(),
  apiSend: vi.fn(),
  apiSendAgent: vi.fn(),
  apiDelete: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status = 0
  },
}))
vi.mock('./auth', () => ({ useAuth: () => ({ login: vi.fn(), logout: vi.fn(), user: null }) }))

import { apiGet } from './api'

const alpha = makeDevice({ id: 'd1', name: 'Alpha Chiller' })
const beta = makeDevice({ id: 'd2', name: 'Beta Freezer' })

function mockApi() {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === '/api/devices') return [alpha, beta]
    if (path === '/api/verticals') return [vertical]
    return [] // telemetry, rules, actuator commands, sites… for the opened device detail
  })
}

describe('form controls have programmatic names (placeholders alone are not names)', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    mockApi()
  })

  it('Devices tab: create form, search, filter and sort', async () => {
    render(<DevicesTab />)
    await screen.findByRole('button', { name: 'Alpha Chiller' })

    for (const [role, name] of [
      ['textbox', 'Device name'],
      ['combobox', 'Device type'],
      ['textbox', 'Location'],
      ['textbox', 'Search devices'],
      ['combobox', 'Filter by status'],
      ['combobox', 'Sort devices'],
    ] as const) {
      expect(screen.getByRole(role, { name }), `${role} "${name}"`).toBeTruthy()
    }
  })

  it('Login: email and password', () => {
    render(<Login />)
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
  })
})

describe('device rows are keyboard-operable', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    mockApi()
  })

  it('each row exposes its name as a real button', async () => {
    render(<DevicesTab />)
    expect(await screen.findByRole('button', { name: 'Alpha Chiller' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Beta Freezer' })).toBeTruthy()
  })

  it('Enter on a focused row opens that device, with no mouse involved', async () => {
    const user = userEvent.setup()
    render(<DevicesTab />)
    const row = await screen.findByRole('button', { name: 'Beta Freezer' })

    row.focus()
    expect(document.activeElement).toBe(row)
    await user.keyboard('{Enter}')

    // The detail view's own controls only exist once a device is selected.
    await screen.findByRole('button', { name: 'Close' })
    expect(screen.getByRole('heading', { name: /Beta Freezer/ })).toBeTruthy()
  })

  it('Space works too', async () => {
    const user = userEvent.setup()
    render(<DevicesTab />)
    const row = await screen.findByRole('button', { name: 'Alpha Chiller' })

    row.focus()
    await user.keyboard(' ')

    await screen.findByRole('button', { name: 'Close' })
  })

  it('marks the open device as current', async () => {
    const user = userEvent.setup()
    render(<DevicesTab />)
    const row = await screen.findByRole('button', { name: 'Alpha Chiller' })
    expect(row.getAttribute('aria-current')).toBeNull()

    await user.click(row)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Alpha Chiller' }).getAttribute('aria-current')).toBe('true'),
    )
  })
})

describe('errors are announced', () => {
  it('a failed load is exposed as an alert', async () => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiGet).mockRejectedValue(new Error('network'))
    render(<DevicesTab />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Failed to load devices')
  })
})

describe('charts have a text alternative', () => {
  const points = [
    { value: 2, timestamp: '2026-01-01T00:00:00Z' },
    { value: 8, timestamp: '2026-01-01T01:00:00Z' },
    { value: 5, timestamp: '2026-01-01T02:00:00Z' },
  ]

  it('LineChart describes the metric, reading count, latest value and range', () => {
    render(<LineChart points={points} label="Chamber Temperature" />)
    const chart = screen.getByRole('img')
    expect(chart.getAttribute('aria-label')).toBe('Chamber Temperature: 3 readings, latest 5, range 2 to 8')
  })

  it('LineChart falls back to a generic name and handles a single reading', () => {
    render(<LineChart points={[points[0]]} />)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Line chart: 1 reading, latest 2, range 2 to 2')
  })

  it('GaugeWidget names the value, with its unit', () => {
    render(<GaugeWidget label="Humidity" value={42} unit="%" />)
    expect(screen.getByRole('img', { name: 'Humidity: 42 %' })).toBeTruthy()
  })
})

describe('emoji-only buttons are named', () => {
  it('agent-run feedback buttons say what they do', async () => {
    const run: AgentRun = {
      id: 'r1',
      status: 'COMPLETED',
      input: {},
      output: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      agent: { id: 'a1', key: 'alert-triage', name: 'Alert triage', description: 'test' },
      alert: null,
      feedback: null,
    }
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiGet).mockResolvedValue([run])
    render(<AgentRunsTab />)

    expect(await screen.findByRole('button', { name: 'Mark this run helpful' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark this run not helpful' })).toBeTruthy()
  })
})
