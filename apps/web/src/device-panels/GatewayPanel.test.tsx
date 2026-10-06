import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDevice } from '../test/fixtures'
import { GatewayPanel } from './GatewayPanel'

vi.mock('../api', () => ({ apiSend: vi.fn() }))

import { apiSend } from '../api'

// A (the device under test) is plain. B is plain. C is already a gateway
// (it has a child). D is that child.
const A = makeDevice({ id: 'A', name: 'Device A' })
const B = makeDevice({ id: 'B', name: 'Device B' })
const C = makeDevice({
  id: 'C',
  name: 'Gateway C',
  childDevices: [{ id: 'D', name: 'Child D', status: 'ONLINE' }],
})
const D = makeDevice({ id: 'D', name: 'Child D', parentDeviceId: 'C' })
const all = [A, B, C, D]

const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent)

describe('GatewayPanel', () => {
  const onChanged = vi.fn()

  beforeEach(() => {
    vi.mocked(apiSend).mockReset()
    vi.mocked(apiSend).mockResolvedValue({})
    onChanged.mockReset()
  })

  it('offers only candidates the server would accept', () => {
    render(<GatewayPanel device={A} allDevices={all} onChanged={onChanged} />)

    // As a child it may attach under any device that has no parent of its own
    // (B, and the existing gateway C) — but not itself, and not D (already a child).
    expect(optionLabels(screen.getByDisplayValue('Attach to gateway…'))).toEqual([
      'Attach to gateway…',
      'Device B',
      'Gateway C',
    ])
    // As a gateway it may adopt only a device with neither a parent nor children
    // (B) — not C (already a gateway) and not D (already a child).
    expect(optionLabels(screen.getByDisplayValue('Add child device…'))).toEqual(['Add child device…', 'Device B'])
  })

  it('attaching to a gateway PATCHes this device with the chosen parent, then refreshes', async () => {
    const user = userEvent.setup()
    render(<GatewayPanel device={A} allDevices={all} onChanged={onChanged} />)

    await user.selectOptions(screen.getByDisplayValue('Attach to gateway…'), 'Gateway C')
    await user.click(screen.getByRole('button', { name: 'Attach' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(apiSend).toHaveBeenCalledWith('/api/devices/A', 'PATCH', { parentDeviceId: 'C' })
  })

  it('adding a child PATCHes the *child* with this device as its parent', async () => {
    const user = userEvent.setup()
    render(<GatewayPanel device={A} allDevices={all} onChanged={onChanged} />)

    await user.selectOptions(screen.getByDisplayValue('Add child device…'), 'Device B')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(apiSend).toHaveBeenCalledWith('/api/devices/B', 'PATCH', { parentDeviceId: 'A' })
  })

  it('the Attach and Add buttons stay disabled until something is chosen', () => {
    render(<GatewayPanel device={A} allDevices={all} onChanged={onChanged} />)

    expect((screen.getByRole('button', { name: 'Attach' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a gateway lists its children, can detach one, and cannot itself become a child', async () => {
    const user = userEvent.setup()
    render(<GatewayPanel device={C} allDevices={all} onChanged={onChanged} />)

    expect(screen.getByText('Child D')).toBeTruthy()
    expect(screen.queryByDisplayValue('Attach to gateway…')).toBeNull() // gateways can't be attached under another

    await user.click(screen.getByRole('button', { name: 'Detach' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(apiSend).toHaveBeenCalledWith('/api/devices/D', 'PATCH', { parentDeviceId: null })
  })

  it('a child shows its gateway, can detach itself, and cannot adopt children of its own', async () => {
    const user = userEvent.setup()
    render(<GatewayPanel device={D} allDevices={all} onChanged={onChanged} />)

    expect(screen.getByText('Gateway C')).toBeTruthy()
    expect(screen.queryByDisplayValue('Add child device…')).toBeNull() // one level only

    await user.click(screen.getByRole('button', { name: 'Detach' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(apiSend).toHaveBeenCalledWith('/api/devices/D', 'PATCH', { parentDeviceId: null })
  })

  it('shows an error and does not refresh when the update fails', async () => {
    const user = userEvent.setup()
    vi.mocked(apiSend).mockRejectedValue(new Error('400'))
    render(<GatewayPanel device={D} allDevices={all} onChanged={onChanged} />)

    await user.click(screen.getByRole('button', { name: 'Detach' }))

    await waitFor(() => expect(screen.getByText('Failed to update gateway assignment')).toBeTruthy())
    expect(onChanged).not.toHaveBeenCalled()
  })
})
