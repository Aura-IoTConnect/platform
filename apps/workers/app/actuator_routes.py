"""Manual actuator dispatch, triggered from apps/api's proxy
(POST /api/devices/:id/actuator) rather than called directly from the
browser — same server-to-server auth boundary as app/agents_routes.py.
See CLAUDE.md.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.actuator_service import dispatch_command
from app.db import devices, get_engine
from app.security import require_workers_token

router = APIRouter(prefix="/devices", tags=["actuator"], dependencies=[Depends(require_workers_token)])


class ActuatorCommandRequest(BaseModel):
    command: str
    value: Optional[Any] = None


@router.post("/{device_id}/actuator")
async def send_actuator_command(device_id: str, body: ActuatorCommandRequest) -> dict:
    engine = get_engine()
    async with engine.begin() as conn:
        known = (await conn.execute(select(devices.c.id).where(devices.c.id == device_id))).first()
        if known is None:
            raise HTTPException(status_code=404, detail="Unknown device_id")
        result = await dispatch_command(conn, device_id, body.command, value=body.value, source="MANUAL")
    return result
