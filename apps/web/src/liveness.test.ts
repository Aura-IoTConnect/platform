import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { livenessBadgeText, livenessLabel, livenessState } from './liveness'

const NOW = new Date('2026-06-01T12:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe('liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a device that never reported is "unknown"', () => {
    expect(livenessState(null)).toBe('unknown')
    expect(livenessBadgeText(null)).toBe('Never reported')
    expect(livenessLabel(null)).toBe('Never reported')
  })

  it('a device heard from within the 10-minute window is live', () => {
    expect(livenessState(minutesAgo(0))).toBe('live')
    expect(livenessState(minutesAgo(5))).toBe('live')
    expect(livenessBadgeText(minutesAgo(5))).toBe('Live')
  })

  it('the window boundary is inclusive: exactly 10 minutes is still live, one second more is stale', () => {
    expect(livenessState(minutesAgo(10))).toBe('live')
    expect(livenessState(new Date(NOW.getTime() - 10 * 60_000 - 1000).toISOString())).toBe('stale')
  })

  it('an old timestamp is stale, and the tooltip carries the actual time', () => {
    const old = minutesAgo(120)
    expect(livenessState(old)).toBe('stale')
    expect(livenessBadgeText(old)).toBe('Stale')
    expect(livenessLabel(old)).toContain('last seen')
    expect(livenessLabel(old)).toContain(new Date(old).toLocaleString())
  })

  it('a timestamp slightly in the future (clock skew) still reads as live', () => {
    expect(livenessState(new Date(NOW.getTime() + 30_000).toISOString())).toBe('live')
  })
})
