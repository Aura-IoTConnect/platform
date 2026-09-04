import { LineChart } from '../LineChart'

interface Point {
  value: number
  timestamp: string
}

export function LineChartWidget({ label, unit, points }: { label: string; unit?: string; points: Point[] }) {
  const latest = points[points.length - 1]
  return (
    <div className="widget line-chart-widget">
      <div className="metric-chart-header">
        <span>{label}</span>
        {latest && (
          <span className="record-subtitle">
            {latest.value}
            {unit ? ` ${unit}` : ''}
          </span>
        )}
      </div>
      <LineChart points={points} />
    </div>
  )
}
