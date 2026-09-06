"""Shared entry point for a telemetry reading, regardless of transport
(HTTP POST /ingestion/telemetry, or MQTT via app/mqtt_client.py). Both call
this so the control loop (pre-process -> persist -> evaluate rules -> alert
-> agent) only has one implementation."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from app.agents import maybe_trigger_anomaly_explainer
from app.db import device_types, devices, get_engine, new_id, telemetry_readings
from app.metric_pipeline import apply_metric_policy, find_metric_config, should_persist
from app.metrics import alerts_created_total, ingestion_readings_total, rule_evaluation_duration_seconds
from app.rule_engine import evaluate

logger = logging.getLogger("telemetry_service")


async def ingest_reading(
    device_id: str,
    metric: str,
    value: float,
    unit: Optional[str] = None,
    timestamp: Optional[datetime] = None,
    transport: str = "http",
) -> dict:
    ts = timestamp or datetime.now(timezone.utc)

    engine = get_engine()
    async with engine.begin() as conn:
        # device_id is a foreign key on telemetry_readings — check existence
        # first so a bad/unknown id fails cleanly instead of a raw FK
        # constraint violation (500) from the insert below. The join also
        # pulls the device type's metrics taxonomy for the pipeline step.
        row = (
            await conn.execute(
                select(device_types.c.metrics)
                .select_from(devices.join(device_types, devices.c.device_type_id == device_types.c.id))
                .where(devices.c.id == device_id)
            )
        ).first()
        if row is None:
            logger.warning("telemetry for unknown device_id=%s — dropped", device_id)
            ingestion_readings_total.labels(transport=transport, outcome="unknown_device").inc()
            return {"status": "unknown_device", "alertsCreated": 0}

        # Pre-process (see app/metric_pipeline.py). A rejected reading is
        # neither persisted nor rule-evaluated — it never existed as far as
        # the control loop is concerned.
        config = find_metric_config(row.metrics, metric)
        value, accepted, reason = apply_metric_policy(config, value)
        if not accepted:
            logger.warning("telemetry rejected device_id=%s metric=%s reason=%s", device_id, metric, reason)
            ingestion_readings_total.labels(transport=transport, outcome="rejected").inc()
            return {"status": "rejected", "reason": reason, "alertsCreated": 0}

        # on-change logging only thins *history*; rules still see every
        # reading (evaluate() below is unconditional).
        if await should_persist(conn, device_id, metric, value, config):
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
        with rule_evaluation_duration_seconds.time():
            created_alerts = await evaluate(conn, device_id, metric, value)

    ingestion_readings_total.labels(transport=transport, outcome="accepted").inc()
    for alert in created_alerts:
        alerts_created_total.labels(severity=alert["severity"]).inc()
        if alert["severity"] == "CRITICAL":
            await maybe_trigger_anomaly_explainer(alert["id"])

    return {"status": "accepted", "alertsCreated": len(created_alerts)}
