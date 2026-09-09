import { useEffect, useState } from 'react'
import { apiDelete, apiGet, apiSend } from './api'
import type { Site } from './types'

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

// A collapsible manager for the Site hierarchy (see CLAUDE.md's "Grouping,
// tags & bulk import/export" section) — distinct from device creation, so
// it lives in its own panel rather than growing DevicesTab's device-add
// form. Sites can nest arbitrarily deep (unlike the one-level gateway
// hierarchy), so the list renders with indentation rather than a flat list.
export function SitesManager() {
  const [open, setOpen] = useState(false)
  const [sites, setSites] = useState<Site[]>([])
  const [name, setName] = useState('')
  const [parentSiteId, setParentSiteId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    apiGet<Site[]>('/api/sites')
      .then(setSites)
      .catch(() => setError('Failed to load sites'))
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  const addSite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setError(null)
    try {
      await apiSend('/api/sites', 'POST', { name, parentSiteId: parentSiteId || undefined })
      setName('')
      load()
    } catch {
      setError('Failed to create site')
    }
  }

  const removeSite = async (id: string) => {
    setError(null)
    try {
      await apiDelete(`/api/sites/${id}`)
      load()
    } catch {
      setError('Site has devices or child sites attached — detach them first')
    }
  }

  return (
    <div className="sites-manager">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide sites' : 'Manage sites'}
      </button>
      {open && (
        <div className="sites-manager-body">
          <form onSubmit={addSite} className="device-form">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Site name" />
            <select value={parentSiteId} onChange={(e) => setParentSiteId(e.target.value)}>
              <option value="">No parent (top level)</option>
              {orderedWithDepth(sites).map(({ site, depth }) => (
                <option key={site.id} value={site.id}>
                  {'— '.repeat(depth)}
                  {site.name}
                </option>
              ))}
            </select>
            <button type="submit">Add site</button>
          </form>
          {error && <p className="error">{error}</p>}
          {sites.length === 0 ? (
            <p className="hint">No sites yet.</p>
          ) : (
            <ul className="record-list">
              {orderedWithDepth(sites).map(({ site, depth }) => (
                <li key={site.id}>
                  <span className="record-title">
                    {'— '.repeat(depth)}
                    {site.name}
                  </span>
                  <button type="button" onClick={() => removeSite(site.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
