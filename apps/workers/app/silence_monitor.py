"""Device-silence ("no data") alarm — a structural blind spot in the
control loop: rule evaluation only ever runs synchronously inside the
ingest path (see rule_engine.py), so a device that stops reporting
entirely breaches nothing and raises no alert. A `Rule` with
`operator: "SILENT_FOR"` (`threshold` = minutes, `metric` = which metric's
absence to watch) is the one rule type that isn't event-driven — there's
no reading to react to, so it's checked periodically instead (see
main.py's lifespan) rather than from telemetry_service.py::ingest_reading.

One new scheduled check, not a chained/graph rule engine: it reuses the
same Alert table, severity, and actionType shape as every other rule, and
mirrors the same "at most one active alert per (device, rule)" dedup
invariant. This branch predates the fuller alert-dedup/cooldown work on
apps/workers/app/rule_engine.py (a sibling branch) — the two will need
reconciling when both land, but this stays self-contained until then.

Auto-clear (an alert resolves once the device reports again) lives in
rule_engine.py's evaluate(), not here — a reading arriving is exactly the
event that ends the silence, so it belongs on that per-reading path.

Split into a pure `_check_silence_rules` (takes an existing connection —
testable against the standard rolled-back-transaction fixture) and the
`check_silence_rules` entry point that owns the transaction, mirroring the
evaluate()/ingest_reading() split elsewhere in this package.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from app.actuator_service import dispatch_command
from app.db import alerts, devices, new_id, rules, telemetry_readings

logger = logging.getLogger("silence_monitor")

ACTIVE_STATUSES = ("OPEN", "ACKNOWLEDGED")


async def _check_silence_rules(conn: AsyncConnection, now: datetime) -> list[dict]:
    created: list[dict] = []

    silence_rules = (
        await conn.execute(select(rules).where(rules.c.operator == "SILENT_FOR", rules.c.enabled.is_(True)))
    ).mappings().all()

    for rule in silence_rules:
        cutoff = now - timedelta(minutes=rule["threshold"])
        target_device_ids = [
            row.id
            for row in (
                await conn.execute(select(devices.c.id).where(devices.c.device_type_id == rule["device_type_id"]))
            ).all()
        ]

        for device_id in target_device_ids:
            last = (
                await conn.execute(
                    select(telemetry_readings.c.timestamp)
                    .where(
                        telemetry_readings.c.device_id == device_id,
                        telemetry_readings.c.metric == rule["metric"],
                    )
                    .order_by(telemetry_readings.c.timestamp.desc())
                    .limit(1)
                )
            ).first()
            last_ts = last.timestamp if last is not None else None
            if last_ts is not None and last_ts.tzinfo is None:
                # See rule_engine.py's identical note: some driver/session
                # configurations hand back a naive datetime for this
                # TIMESTAMPTZ column even though it's always written in UTC.
                last_ts = last_ts.replace(tzinfo=timezone.utc)
            silent = last_ts is None or last_ts < cutoff
            if not silent:
                continue

            existing = (
                await conn.execute(
                    select(alerts.c.id).where(
                        alerts.c.device_id == device_id,
                        alerts.c.rule_id == rule["id"],
                        alerts.c.status.in_(ACTIVE_STATUSES),
                    )
                )
            ).first()
            if existing is not None:
                continue  # already alerting — dedup, same invariant as the per-reading loop

            alert_id = new_id()
            message = f"{rule['name']}: no {rule['metric']} reading for over {rule['threshold']} minutes"
            await conn.execute(
                alerts.insert().values(
                    id=alert_id,
                    device_id=device_id,
                    rule_id=rule["id"],
                    severity=rule["severity"],
                    message=message,
                    status="OPEN",
                    created_at=now,
                    resolved_at=None,
                )
            )

            action_type = rule["action_type"]
            action_config = rule["action_config"] or {}
            if action_type == "actuator":
                command = action_config.get("command", "unknown")
                await dispatch_command(conn, device_id, command, source="RULE", rule_id=rule["id"])
            else:
                logger.info("notify: %s", message)

            created.append(
                {
                    "id": alert_id,
                    "deviceId": device_id,
                    "ruleId": rule["id"],
                    "severity": rule["severity"],
                    "message": message,
                }
            )

    return created


async def check_silence_rules(engine: AsyncEngine, now: datetime | None = None) -> list[dict]:
    """One pass over every enabled SILENT_FOR rule and every device of that
    rule's DeviceType. Returns the newly created alerts (empty if nothing
    is newly silent, or everything silent already has an active alert)."""
    async with engine.begin() as conn:
        return await _check_silence_rules(conn, now or datetime.now(timezone.utc))
