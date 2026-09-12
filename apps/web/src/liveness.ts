// Display-only liveness threshold — a device counts as "live" if it's been
// heard from (telemetry ingestion or POST /ingestion/heartbeat) within this
// window. No server-side equivalent: distinct from the SILENT_FOR rule type
// (which creates real Alerts, is per-metric, and is scoped to a
// DeviceType). See CLAUDE.md's "Liveness signal & Devices tab search"
// section.
const LIVE_WINDOW_MS = 10 * 60 * 1000

export type LivenessState = 'live' | 'stale' | 'unknown'

export function livenessState(lastSeenAt: string | null): LivenessState {
  if (!lastSeenAt) return 'unknown'
  const age = Date.now() - new Date(lastSeenAt).getTime()
  return age <= LIVE_WINDOW_MS ? 'live' : 'stale'
}

// Short text for the badge itself (livenessLabel below is the longer
// tooltip/title text with the actual timestamp).
export function livenessBadgeText(lastSeenAt: string | null): string {
  const state = livenessState(lastSeenAt)
  if (state === 'live') return 'Live'
  if (state === 'stale') return 'Stale'
  return 'Never reported'
}

export function livenessLabel(lastSeenAt: string | null): string {
  const state = livenessState(lastSeenAt)
  if (state === 'unknown') return 'Never reported'
  if (state === 'live') return 'Live'
  return `Stale · last seen ${new Date(lastSeenAt!).toLocaleString()}`
}
