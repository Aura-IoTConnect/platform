const SIZE = 90
const STROKE_WIDTH = 8
const RADIUS = (SIZE - STROKE_WIDTH) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function GaugeWidget({
  label,
  value,
  unit,
  min = 0,
  max = 100,
}: {
  label: string
  value: number
  unit?: string
  min?: number
  max?: number
}) {
  const range = max - min || 1
  const fraction = Math.min(1, Math.max(0, (value - min) / range))
  const offset = CIRCUMFERENCE * (1 - fraction)

  return (
    <div className="widget gauge-widget">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={STROKE_WIDTH} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={STROKE_WIDTH}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="gauge-value">
          {value}
          {unit ? ` ${unit}` : ''}
        </text>
      </svg>
      <span className="widget-label">{label}</span>
    </div>
  )
}
