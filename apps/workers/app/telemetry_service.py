"""Shared entry point for a telemetry reading, regardless of transport
(HTTP POST /ingestion/telemetry, or MQTT via app/mqtt_client.py). Both call
this so the control loop (persist -> evaluate rules -> alert -> agent) only
has one implementation."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from app.agents import maybe_trigger_anomaly_explainer
from app.db import get_engine, new_id, telemetry_readings
from app.rule_engine import evaluate


async def ingest_reading(
    device_id: str,
    metric: str,
    value: float,
    unit: Optional[str] = None,
    timestamp: Optional[datetime] = None,
) -> dict:
    ts = timestamp or datetime.now(timezone.utc)

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            telemetry_readings.insert().values(
                id=new_id(),
                device_id=device_id,
                metric=metric,
                value=value,
                unit=unit,
                timestamp=ts,
            )
        )
        created_alerts = await evaluate(conn, device_id, metric, value)

    for alert in created_alerts:
        if alert["severity"] == "CRITICAL":
            await maybe_trigger_anomaly_explainer(alert["id"])

    return {"status": "accepted", "alertsCreated": len(created_alerts)}
