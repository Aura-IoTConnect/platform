"""Actuator command dispatch — the real implementation behind Rule's
`actionType: "actuator"` (previously just logged via `logger.info`, never
persisted). There's no real hardware behind this yet; `dispatch_command`
persists an `ActuatorCommand` row as the audit trail / dispatch record a
real integration would write to.

Two callers:
- `app/rule_engine.py`, on an actuator-type rule breach (`source="RULE"`),
  within the same transaction as the alert it's paired with.
- `app/actuator_routes.py`'s `POST /devices/{id}/actuator`, a manual trigger
  proxied from apps/api's `POST /api/devices/:id/actuator` (`source="MANUAL"`).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import actuator_commands, new_id

logger = logging.getLogger("actuator")


async def dispatch_command(
    conn: AsyncConnection,
    device_id: str,
    command: str,
    *,
    value: Optional[Any] = None,
    source: str = "MANUAL",
    rule_id: Optional[str] = None,
) -> dict:
    command_id = new_id()
    await conn.execute(
        actuator_commands.insert().values(
            id=command_id,
            device_id=device_id,
            rule_id=rule_id,
            command=command,
            value=value,
            source=source,
            created_at=datetime.now(timezone.utc),
        )
    )
    logger.info("dispatched actuator command=%s device_id=%s source=%s", command, device_id, source)
    return {"id": command_id, "deviceId": device_id, "command": command, "value": value, "source": source}
