import type { Device, WidgetDef } from '../types'
import { AlarmTableWidget } from './AlarmTableWidget'
import { GaugeWidget } from './GaugeWidget'
import { LineChartWidget } from './LineChartWidget'
import { StatTile } from './StatTile'

interface Reading {
  value: number
  timestamp: string
}

// Declarative rendering of a DeviceType's `defaultWidgets` config against a
// specific device's telemetry — see types.ts's WidgetDef and CLAUDE.md.
export function WidgetRenderer({
  device,
  widgets,
  readingsByMetric,
}: {
  device: Device
  widgets: WidgetDef[]
  readingsByMetric: Map<string, Reading[]>
}) {
  return (
    <div className="widget-grid">
      {widgets.map((widget, i) => {
        if (widget.type === 'alarm-table') {
          return <AlarmTableWidget key={i} deviceId={device.id} />
        }

        const metricKey = widget.metricKey
        if (!metricKey) return null

        const meta = device.deviceType.metrics.find((m) => m.key === metricKey)
        const points = readingsByMetric.get(metricKey) ?? []
        const latest = points[points.length - 1]
        const label = widget.label ?? meta?.label ?? metricKey

        switch (widget.type) {
          case 'line-chart':
            return <LineChartWidget key={i} label={label} unit={meta?.unit} points={points} />
          case 'gauge':
            return latest ? (
              <GaugeWidget key={i} label={label} value={latest.value} unit={meta?.unit} min={meta?.min} max={meta?.max} />
            ) : (
              <p key={i} className="hint">
                No data yet for {label}.
              </p>
            )
          case 'stat-tile':
            return latest ? (
              <StatTile key={i} label={label} value={latest.value} unit={meta?.unit} />
            ) : (
              <p key={i} className="hint">
                No data yet for {label}.
              </p>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
