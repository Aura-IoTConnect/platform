interface Point {
  value: number
  timestamp: string
}

export function LineChart({ points, width = 280, height = 56 }: { points: Point[]; width?: number; height?: number }) {
  if (points.length === 0) {
    return <p className="hint">No data yet.</p>
  }

  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pad = 4

  const coords = points.map((p, i) => {
    const x = points.length > 1 ? (i / (points.length - 1)) * (width - pad * 2) + pad : width / 2
    const y = height - pad - ((p.value - min) / range) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} className="line-chart" preserveAspectRatio="none">
      <polyline points={coords.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  )
}
