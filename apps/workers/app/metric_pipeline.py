"""Ingest-time metric pipeline — the one pre-processing step between a raw
reading arriving and the persist -> evaluate-rules control loop in
telemetry_service.py. Configured per metric in DeviceType.metrics (see the
comment on that field in apps/api/prisma/schema.prisma):

    {
      key, label, unit, min?, max?,
      transform?:    { type: "linear", factor, offset }   # value*factor + offset
      onOutOfRange?: "pass" | "clamp" | "reject"         # against min/max; default "pass"
      loggingMode?:  "always" | "on-change"              # default "always"
      deadband?:     number                              # for "on-change"
    }

The concept is borrowed from the staged input -> processors -> output model
shared by Telegraf (its `scale` and `filter` processors), NiFi (a failure
routed away from the success relationship instead of handed downstream)
and Node-RED (Function/Switch/Change nodes), plus the per-point logging
modes in RapidSCADA archives and ScadaBR ("all data / changes only") — but
it is deliberately a fixed set of built-in kinds dispatched on a `type`
string, the same convention `defaultWidgets` already uses, not a plugin
loader or arbitrary-code stage.

Two rules the rest of the platform relies on:
- `transform` and `onOutOfRange` change the value the rule engine sees.
- `loggingMode`/`deadband` only change what is *persisted* to
  telemetry_readings — rule evaluation still runs on every reading, so
  alerting behavior is unaffected by history thinning.
"""

from __future__ import annotations

import math
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import telemetry_readings

VALID_OUT_OF_RANGE = ("pass", "clamp", "reject")
VALID_LOGGING_MODES = ("always", "on-change")


def find_metric_config(metrics: Any, metric: str) -> Optional[dict]:
    """DeviceType.metrics is free-form JSON; tolerate anything that isn't
    the expected list-of-dicts rather than failing ingestion over it."""
    if not isinstance(metrics, list):
        return None
    for entry in metrics:
        if isinstance(entry, dict) and entry.get("key") == metric:
            return entry
    return None


def apply_metric_policy(config: Optional[dict], raw_value: float) -> tuple[float, bool, Optional[str]]:
    """Returns (value, accepted, reject_reason). Pure — no I/O."""
    if config is None:
        return raw_value, True, None

    value = raw_value
    transform = config.get("transform")
    if isinstance(transform, dict) and transform.get("type") == "linear":
        factor = _num(transform.get("factor"), 1.0)
        offset = _num(transform.get("offset"), 0.0)
        value = value * factor + offset

    if not math.isfinite(value):
        # NaN/inf can't be compared against a threshold meaningfully and
        # would poison min/max on the dashboard — never accept them.
        return value, False, "non_finite"

    mode = config.get("onOutOfRange", "pass")
    if mode not in VALID_OUT_OF_RANGE:
        mode = "pass"
    lo = config.get("min")
    hi = config.get("max")
    below = isinstance(lo, (int, float)) and value < lo
    above = isinstance(hi, (int, float)) and value > hi
    if mode == "reject" and (below or above):
        return value, False, "out_of_range"
    if mode == "clamp":
        if below:
            value = float(lo)
        if above:
            value = float(hi)

    return value, True, None


async def should_persist(conn: AsyncConnection, device_id: str, metric: str, value: float, config: Optional[dict]) -> bool:
    """`on-change` logging: skip the history row when the value hasn't moved
    past `deadband` since the last *stored* reading for this (device,
    metric). A first-ever reading is always stored."""
    if config is None or config.get("loggingMode", "always") != "on-change":
        return True

    deadband = _num(config.get("deadband"), 0.0)
    last = (
        await conn.execute(
            select(telemetry_readings.c.value)
            .where(telemetry_readings.c.device_id == device_id, telemetry_readings.c.metric == metric)
            .order_by(telemetry_readings.c.timestamp.desc())
            .limit(1)
        )
    ).first()
    if last is None:
        return True
    return abs(value - float(last.value)) > deadband


def _num(raw: Any, default: float) -> float:
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else default
