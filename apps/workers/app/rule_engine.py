"""The closed control loop: sense (telemetry in) -> analyze (rule evaluation)
-> decide (breach?) -> act (alert + dispatched action) -> next reading.

`evaluate` is called by app/ingestion.py right after a reading is persisted.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.actuator_service import dispatch_command
from app.db import alerts, devices, new_id, rules

logger = logging.getLogger("rule_engine")

OPERATORS = {
    "GT": lambda value, threshold: value > threshold,
    "GTE": lambda value, threshold: value >= threshold,
    "LT": lambda value, threshold: value < threshold,
    "LTE": lambda value, threshold: value <= threshold,
    "EQ": lambda value, threshold: value == threshold,
}


async def evaluate(conn: AsyncConnection, device_id: str, metric: str, value: float) -> list[dict]:
    """Evaluate all enabled rules for this device's type + metric against the
    new reading. Returns the alerts created (empty if nothing breached)."""

    device_row = (
        await conn.execute(select(devices.c.device_type_id).where(devices.c.id == device_id))
    ).first()
    if device_row is None:
        logger.warning("telemetry for unknown device_id=%s", device_id)
        return []

    device_type_id = device_row.device_type_id

    matching_rules = (
        await conn.execute(
            select(rules).where(
                rules.c.device_type_id == device_type_id,
                rules.c.metric == metric,
                rules.c.enabled.is_(True),
            )
        )
    ).mappings().all()

    created_alerts: list[dict] = []
    for rule in matching_rules:
        predicate = OPERATORS[rule["operator"]]
        if not predicate(value, rule["threshold"]):
            continue

        alert_id = new_id()
        message = f"{rule['name']}: {metric}={value} breached {rule['operator']} {rule['threshold']}"
        await conn.execute(
            alerts.insert().values(
                id=alert_id,
                device_id=device_id,
                rule_id=rule["id"],
                severity=rule["severity"],
                message=message,
                status="OPEN",
                created_at=datetime.now(timezone.utc),
                resolved_at=None,
            )
        )

        if rule["action_type"] == "actuator":
            command = (rule["action_config"] or {}).get("command", "unknown")
            await dispatch_command(conn, device_id, command, source="RULE", rule_id=rule["id"])
        elif rule["action_type"] == "webhook":
            logger.info("would call webhook=%s for rule=%s", (rule["action_config"] or {}).get("url"), rule["name"])
        else:
            logger.info("notify: %s", message)

        created_alerts.append(
            {
                "id": alert_id,
                "deviceId": device_id,
                "ruleId": rule["id"],
                "severity": rule["severity"],
                "message": message,
            }
        )

    return created_alerts
