import { useEffect, useState } from 'react'
import { apiGet, apiSend } from '../api'
import type { Device, Site } from '../types'

// Orders sites into a depth-first, parent-before-child list with each
// site's tree depth, so a flat <select> can render indented option labels
// without a separate tree-rendering component.
function orderedWithDepth(sites: Site[]): { site: Site; depth: number }[] {
  const byParent = new Map<string | null, Site[]>()
  for (const site of sites) {
    const key = site.parentSiteId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(site)
  }
  const out: { site: Site; depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const site of byParent.get(parentId) ?? []) {
      out.push({ site, depth })
      walk(site.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

// Free-form tags + optional Site assignment — a second, independent axis of
// grouping from the gateway/child hierarchy (GatewayPanel) and from the
// plain-text `location` field (DeviceInfoPanel). Self-fetches the site
// list, same self-contained-panel convention as ServiceLogPanel; a newly
// added site won't appear here until this panel remounts (the same minor
// staleness tradeoff already accepted elsewhere in this file — see
// CLAUDE.md's "Grouping, tags & bulk import/export" section).
export function GroupingPanel({ device: initialDevice }: { device: Device }) {
  const [device, setDevice] = useState(initialDevice)
  const [sites, setSites] = useState<Site[]>([])
  const [editing, setEditing] = useState(false)
  const [tagsText, setTagsText] = useState(device.tags.join(', '))
  const [siteId, setSiteId] = useState(device.siteId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiGet<Site[]>('/api/sites')
      .then(setSites)
      .catch(() => {})
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const updated = await apiSend<Device>(`/api/devices/${device.id}`, 'PATCH', {
        tags,
        siteId: siteId || null,
      })
      setDevice(updated)
      setEditing(false)
    } catch {
      setError('Failed to save grouping')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="grouping-panel">
        <div className="device-info-header">
          <span className="widget-label">Grouping</span>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        {device.tags.length > 0 && (
          <div className="tag-list">
            {device.tags.map((tag) => (
              <span key={tag} className="tag-chip">
                {tag}
              </span>
            ))}
          </div>
        )}
        <p className="hint">{device.site ? `Site: ${device.site.name}` : 'No site assigned.'}</p>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  return (
    <form onSubmit={save} className="device-form device-info-form">
      <input
        type="text"
        value={tagsText}
        onChange={(e) => setTagsText(e.target.value)}
        placeholder="Tags, comma separated (e.g. freezer, critical)"
      />
      <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
        <option value="">No site</option>
        {orderedWithDepth(sites).map(({ site, depth }) => (
          <option key={site.id} value={site.id}>
            {'— '.repeat(depth)}
            {site.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={() => setEditing(false)} disabled={saving}>
        Cancel
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
