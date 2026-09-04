export function StatTile({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div className="widget stat-tile">
      <span className="stat-tile-value">
        {value}
        {unit && <span className="stat-tile-unit"> {unit}</span>}
      </span>
      <span className="widget-label">{label}</span>
    </div>
  )
}
