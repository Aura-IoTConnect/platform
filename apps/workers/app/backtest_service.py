"""Rule backtest — dry-run a candidate rule (metric + operator + threshold,
scoped to a DeviceType) against telemetry the platform already has stored,
with zero side effects: no Alert / ActuatorCommand rows, no notify/webhook
dispatch, no cooldown consumed. Answers "how often would this have fired?"
before an operator enables it live.

The inspiration is the validate-before-deploy principle behind
OpenModelica/OMSimulator-style co-simulation (test the controller against
the plant before it drives real equipment), scaled down to what this
platform actually is: one flat condition row replayed over stored rows,
not a physics solver.

Reuses rule_engine.OPERATORS so the comparison is byte-for-byte the live
one, and replays a simplified version of the live alert lifecycle per
device — a breach opens an "episode", the episode stays open while readings
keep breaching, and closes on the first non-breaching reading — so the
estimate is in alert-episodes an operator would actually see, not raw
breaching-reading counts.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import devices, telemetry_readings
from app.rule_engine import OPERATORS


async def backtest_rule(
    conn: AsyncConnection,
    device_type_id: str,
    metric: str,
    operator: str,
    threshold: float,
    since_hours: int = 168,
    now: Optional[datetime] = None,
) -> dict:
    if operator not in OPERATORS:
        raise ValueError(f"unknown operator {operator!r}")
    predicate = OPERATORS[operator]
    since = (now or datetime.now(timezone.utc)) - timedelta(hours=since_hours)

    rows = (
        await conn.execute(
            select(
                telemetry_readings.c.device_id,
                devices.c.name.label("device_name"),
                telemetry_readings.c.value,
                telemetry_readings.c.timestamp,
            )
            .select_from(telemetry_readings.join(devices, telemetry_readings.c.device_id == devices.c.id))
            .where(
                devices.c.device_type_id == device_type_id,
                telemetry_readings.c.metric == metric,
                telemetry_readings.c.timestamp >= since,
            )
            .order_by(telemetry_readings.c.device_id, telemetry_readings.c.timestamp)
        )
    ).all()

    by_device: dict[str, dict] = {}
    for row in rows:
        entry = by_device.setdefault(
            row.device_id,
            {
                "deviceId": row.device_id,
                "deviceName": row.device_name,
                "readings": 0,
                "breaching": 0,
                "episodes": 0,
                "firstBreachAt": None,
                "lastBreachAt": None,
                "_open": False,
            },
        )
        entry["readings"] += 1
        breached = predicate(float(row.value), threshold)
        if breached:
            entry["breaching"] += 1
            ts = row.timestamp.isoformat()
            entry["firstBreachAt"] = entry["firstBreachAt"] or ts
            entry["lastBreachAt"] = ts
            if not entry["_open"]:
                entry["episodes"] += 1
                entry["_open"] = True
        else:
            entry["_open"] = False

    per_device = []
    for entry in by_device.values():
        entry.pop("_open")
        per_device.append(entry)

    return {
        "sinceHours": since_hours,
        "devicesEvaluated": len(per_device),
        "readingsEvaluated": sum(d["readings"] for d in per_device),
        "breachingReadings": sum(d["breaching"] for d in per_device),
        "estimatedEpisodes": sum(d["episodes"] for d in per_device),
        "byDevice": per_device,
    }
