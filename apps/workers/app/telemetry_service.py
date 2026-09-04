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
from app.webhook_service import dispatch_webhook

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
        # constraint violation (500) from the insert below.
        known = (
            await conn.execute(select(devices.c.id).where(devices.c.id == device_id))
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

    # Outside the transaction, same reason as the AI trigger below: neither
    # is fast, guaranteed-local DB work, and this connection shouldn't sit
    # open for the duration of a network call.
    for alert in created_alerts:
        pending_webhook = alert["pendingWebhook"]
        if pending_webhook is not None:
            await dispatch_webhook(pending_webhook["url"], pending_webhook["payload"])
        if alert["severity"] == "CRITICAL":
            await maybe_trigger_anomaly_explainer(alert["id"])

    return {"status": "accepted", "alertsCreated": len(created_alerts)}
