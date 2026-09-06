"""The closed control loop: sense (telemetry in) -> analyze (rule evaluation)
-> decide (breach?) -> act (alert + dispatched action) -> next reading.

`evaluate` is called by app/ingestion.py right after a reading is persisted,
inside the same DB transaction as the telemetry insert. It must not perform
network I/O itself (see the `pendingWebhook` note below) — that's why
webhook dispatch is handed back to the caller instead of made inline here,
mirroring how telemetry_service.py already defers the anomaly-explainer AI
call until after the transaction commits.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

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

ACTIVE_STATUSES = ("OPEN", "ACKNOWLEDGED")

# Suppresses repeat notify/webhook dispatch for the same (device, rule) pair
# across alert *episodes* within this window — without it, a metric flapping
# across its threshold (breach -> auto-clear -> breach -> ...) would re-fire
# a notification on every flap. Does not affect how often an Alert row is
# created/history-tracked, and does not affect actuator dispatch (a
# continuous control signal, not a notification — see below).
NOTIFY_COOLDOWN_SECONDS = int(os.environ.get("NOTIFY_COOLDOWN_SECONDS", "300"))


async def evaluate(conn: AsyncConnection, device_id: str, metric: str, value: float) -> list[dict]:
    """Evaluate all enabled rules for this device's type + metric against the
    new reading. Returns the *newly created* alerts (empty if nothing newly
    breached) — an ongoing breach that already has an active alert doesn't
    appear here again, so callers (e.g. the CRITICAL -> anomaly-explainer
    auto-trigger, and now webhook dispatch) don't re-fire per reading.

    Each returned dict carries a `pendingWebhook` key (`{"url", "payload"}`
    or `None`) for the caller to dispatch *after* this function's transaction
    commits — see the module docstring."""

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

    now = datetime.now(timezone.utc)
    created_alerts: list[dict] = []

    for rule in matching_rules:
        predicate = OPERATORS[rule["operator"]]
        breached = predicate(value, rule["threshold"])

        # Most recent alert for this (device, rule) pair, any status — used
        # both for the dedup check (is there an active one already?) and,
        # once resolved, as the cooldown anchor for the *next* episode.
        last_alert = (
            await conn.execute(
                select(alerts.c.id, alerts.c.status, alerts.c.last_notified_at)
                .where(alerts.c.device_id == device_id, alerts.c.rule_id == rule["id"])
                .order_by(alerts.c.created_at.desc())
                .limit(1)
            )
        ).first()
        is_active = last_alert is not None and last_alert.status in ACTIVE_STATUSES

        if not breached:
            if is_active:
                # Condition recovered on its own — auto-clear rather than
                # leaving a stale OPEN alert for an operator to close by hand.
                await conn.execute(
                    alerts.update().where(alerts.c.id == last_alert.id).values(status="RESOLVED", resolved_at=now)
                )
            continue

        action_type = rule["action_type"]
        action_config = rule["action_config"] or {}

        if is_active:
            # Still breaching, but already alerting for this rule+device —
            # no duplicate Alert row, no repeat notify/webhook. Actuator
            # dispatch is the one exception: it's a control signal that
            # should keep firing while the condition holds, not a
            # notification, so it's not deduped or cooldown-gated.
            if action_type == "actuator":
                command = action_config.get("command", "unknown")
                await dispatch_command(conn, device_id, command, source="RULE", rule_id=rule["id"])
            continue

        # New episode. If the *previous* episode for this (device, rule)
        # notified recently, suppress this one's notification (flapping
        # protection) — but still record the alert itself for history.
        last_notified_at = last_alert.last_notified_at if last_alert is not None else None
        if last_notified_at is not None and last_notified_at.tzinfo is None:
            # asyncpg/SQLAlchemy hands back a naive datetime for this
            # TIMESTAMPTZ column in some driver/session configurations even
            # though it's always stored and written here in UTC.
            last_notified_at = last_notified_at.replace(tzinfo=timezone.utc)
        cooldown_active = (
            last_notified_at is not None and now - last_notified_at < timedelta(seconds=NOTIFY_COOLDOWN_SECONDS)
        )
        notifies_now = action_type in ("notify", "webhook") and not cooldown_active

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
                created_at=now,
                resolved_at=None,
                last_notified_at=now if notifies_now else None,
            )
        )

        pending_webhook = None
        if action_type == "actuator":
            command = action_config.get("command", "unknown")
            await dispatch_command(conn, device_id, command, source="RULE", rule_id=rule["id"])
        elif action_type == "webhook":
            if notifies_now:
                pending_webhook = {
                    "url": action_config.get("url"),
                    "payload": {
                        "ruleId": rule["id"],
                        "ruleName": rule["name"],
                        "deviceId": device_id,
                        "metric": metric,
                        "value": value,
                        "severity": rule["severity"],
                        "alertId": alert_id,
                    },
                }
            else:
                logger.info("webhook for rule=%s suppressed by cooldown", rule["name"])
        elif notifies_now:
            logger.info("notify: %s", message)
        else:
            logger.info("notify for rule=%s suppressed by cooldown", rule["name"])

        created_alerts.append(
            {
                "id": alert_id,
                "deviceId": device_id,
                "ruleId": rule["id"],
                "severity": rule["severity"],
                "message": message,
                "pendingWebhook": pending_webhook,
            }
        )

    return created_alerts
