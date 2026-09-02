"""Shared entry point for a telemetry reading, regardless of transport
(HTTP POST /ingestion/telemetry, or MQTT via app/mqtt_client.py). Both call
this so the control loop (persist -> evaluate rules -> alert -> agent) only
has one implementation."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from app.agents import maybe_trigger_anomaly_explainer
from app.db import devices, get_engine, new_id, telemetry_readings
from app.rule_engine import evaluate

logger = logging.getLogger("telemetry_service")


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
        # device_id is a foreign key on telemetry_readings — check existence
        # first so a bad/unknown id fails cleanly instead of a raw FK
        # constraint violation (500) from the insert below. A soft-deleted
        # device (deleted_at set) is treated the same as unknown.
        known = (
            await conn.execute(
                select(devices.c.id).where(devices.c.id == device_id, devices.c.deleted_at.is_(None))
            )
        ).first()
        if known is None:
            logger.warning("telemetry for unknown device_id=%s — dropped", device_id)
            return {"status": "unknown_device", "alertsCreated": 0}

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
