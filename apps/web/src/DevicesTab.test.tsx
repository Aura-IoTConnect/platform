import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesTab } from './DevicesTab'
import { makeDevice, vertical } from './test/fixtures'
import type { Device } from './types'

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

import { apiGet } from './api'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

// API order is newest-first, which is what the "Newest first" sort relies on.
const devices: Device[] = [
  makeDevice({
    id: 'd1',
    name: 'Zulu Freezer',
    status: 'OFFLINE',
    tags: ['critical'],
    lastSeenAt: minutesAgo(120),
    location: 'Dock 4',
  }),
  makeDevice({
    id: 'd2',
    name: 'Alpha Chiller',
    status: 'ONLINE',
    tags: ['freezer'],
    lastSeenAt: minutesAgo(1),
    site: { id: 's1', name: 'North Warehouse', parentSiteId: null, createdAt: '2026-01-01T00:00:00.000Z' },
  }),
  makeDevice({ id: 'd3', name: 'Mike Cooler', status: 'MAINTENANCE', lastSeenAt: null }),
]

function names(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('li.clickable .record-title')).map((el) => el.textContent ?? '')
}

async function renderTab() {
  const view = render(<DevicesTab />)
  await screen.findByText('Alpha Chiller')
  return view
}

describe('DevicesTab list, search, filter and sort', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path === '/api/devices') return devices
      if (path === '/api/verticals') return [vertical]
      throw new Error(`unexpected GET ${path}`)
    })
  })

  it('lists devices in API order with a liveness badge each', async () => {
    const { container } = await renderTab()

    expect(names(container)).toEqual(['Zulu Freezer', 'Alpha Chiller', 'Mike Cooler'])
    expect(screen.getByText('Live')).toBeTruthy()
    expect(screen.getByText('Stale')).toBeTruthy()
    expect(screen.getByText('Never reported')).toBeTruthy()
  })

  it('search matches name, tag, site and location, case-insensitively', async () => {
    const user = userEvent.setup()
    const { container } = await renderTab()
    const search = screen.getByPlaceholderText(/Search name/)

    await user.type(search, 'FREEZER') // matches Zulu Freezer (name) AND Alpha Chiller (tag "freezer")
    expect(names(container)).toEqual(['Zulu Freezer', 'Alpha Chiller'])

    await user.clear(search)
    await user.type(search, 'north warehouse') // site name
    expect(names(container)).toEqual(['Alpha Chiller'])

    await user.clear(search)
    await user.type(search, 'dock 4') // location
    expect(names(container)).toEqual(['Zulu Freezer'])
  })

  it('says so when nothing matches, rather than showing an empty list', async () => {
    const user = userEvent.setup()
    const { container } = await renderTab()

    await user.type(screen.getByPlaceholderText(/Search name/), 'no-such-device')

    expect(names(container)).toEqual([])
    expect(screen.getByText('No devices match your search/filter.')).toBeTruthy()
  })

  it('filters by status', async () => {
    const user = userEvent.setup()
    const { container } = await renderTab()

    await user.selectOptions(screen.getByDisplayValue('All statuses'), 'MAINTENANCE')
    expect(names(container)).toEqual(['Mike Cooler'])

    await user.selectOptions(screen.getByDisplayValue('Maintenance'), 'ALL')
    expect(names(container)).toHaveLength(3)
  })

  it('search and status filter combine', async () => {
    const user = userEvent.setup()
    const { container } = await renderTab()

    await user.type(screen.getByPlaceholderText(/Search name/), 'freezer')
    await user.selectOptions(screen.getByDisplayValue('All statuses'), 'ONLINE')

    expect(names(container)).toEqual(['Alpha Chiller'])
  })

  it('sorts by name', async () => {
    const user = userEvent.setup()
    const { container } = await renderTab()

    await user.selectOptions(screen.getByDisplayValue('Newest first'), 'name')

    expect(names(container)).toEqual(['Alpha Chiller', 'Mike Cooler', 'Zulu Freezer'])
  })

  it('sorts by last seen: most recent first, never-reported devices last', async () => {
    const user = userEvent.setup()
    const { container } = await renderTab()

    await user.selectOptions(screen.getByDisplayValue('Newest first'), 'lastSeenAt')

    expect(names(container)).toEqual(['Alpha Chiller', 'Zulu Freezer', 'Mike Cooler'])
  })

  it('shows an empty-fleet message, distinct from the no-match message', async () => {
    vi.mocked(apiGet).mockImplementation(async (path: string) => (path === '/api/devices' ? [] : [vertical]))
    render(<DevicesTab />)

    await waitFor(() => expect(screen.getByText('No devices yet.')).toBeTruthy())
  })

  it('shows an error when the device list fails to load', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('network'))
    render(<DevicesTab />)

    await waitFor(() => expect(screen.getByText('Failed to load devices')).toBeTruthy())
  })
})
