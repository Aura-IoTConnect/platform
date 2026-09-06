import { useEffect, useRef } from 'react'

export interface MimicBinding {
  elementId: string
  metricKey: string
  mode: 'text' | 'fill' | 'visibility'
  // For 'fill': first entry whose `upTo` >= value wins; last entry may omit
  // upTo as the catch-all. For 'visibility': element shown when value > 0.
  thresholds?: { upTo?: number; color: string }[]
  unit?: string
}

// Strip anything executable. The SVG comes from DeviceType.defaultWidgets
// (seed data / admin config behind JWT), so this is defence in depth, not
// the trust boundary — but it costs nothing and rules out a pasted-in
// <script> or onload= from ever running in an operator's session.
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '')
}

function pickColor(value: number, thresholds: MimicBinding['thresholds']): string | null {
  if (!thresholds || thresholds.length === 0) return null
  for (const t of thresholds) {
    if (t.upTo === undefined || value <= t.upTo) return t.color
  }
  return thresholds[thresholds.length - 1].color
}

// A synoptic/mimic screen: static SVG markup with element ids bound to
// live metric values — text readouts, threshold-colored fills, show/hide
// indicators. Deliberately a fifth *widget type* in the existing library,
// authored externally (Inkscape, etc.) and pasted into seed data, not an
// in-app drag-and-drop screen editor. See CLAUDE.md, Dashboard widgets.
export function SvgMimicWidget({
  label,
  svg,
  bindings,
  latestByMetric,
}: {
  label: string
  svg: string
  bindings: MimicBinding[]
  latestByMetric: Map<string, number>
}) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = container.current
    if (!root) return
    for (const b of bindings) {
      const el = root.querySelector<SVGElement>(`#${CSS.escape(b.elementId)}`)
      if (!el) continue
      const value = latestByMetric.get(b.metricKey)
      if (value === undefined) {
        if (b.mode === 'text') el.textContent = '—'
        if (b.mode === 'visibility') el.setAttribute('visibility', 'hidden')
        continue
      }
      if (b.mode === 'text') el.textContent = `${value}${b.unit ? ` ${b.unit}` : ''}`
      if (b.mode === 'fill') {
        const color = pickColor(value, b.thresholds)
        if (color) el.setAttribute('fill', color)
      }
      if (b.mode === 'visibility') el.setAttribute('visibility', value > 0 ? 'visible' : 'hidden')
    }
  }, [bindings, latestByMetric])

  return (
    <div className="widget svg-mimic-widget">
      <span className="widget-label">{label}</span>
      {/* eslint-disable-next-line react/no-danger */}
      <div ref={container} className="svg-mimic" dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }} />
    </div>
  )
}
