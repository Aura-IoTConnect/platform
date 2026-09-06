"""Per-device MQTT credential provisioning, triggered from apps/api's device
create/rotate-key/delete routes (proxied server-side, same pattern as
app/actuator_routes.py and app/agents_routes.py — WORKERS_API_TOKEN never
reaches the browser). See CLAUDE.md's "Per-device MQTT auth" section.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.mqtt_dynsec import DynsecUnavailable, deprovision_device, provision_device
from app.security import require_workers_token

router = APIRouter(prefix="/devices", tags=["mqtt-credentials"], dependencies=[Depends(require_workers_token)])


class MqttCredentialsRequest(BaseModel):
    password: str


@router.post("/{device_id}/mqtt-credentials")
async def set_mqtt_credentials(device_id: str, body: MqttCredentialsRequest) -> dict:
    try:
        await provision_device(device_id, body.password)
    except DynsecUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"deviceId": device_id, "provisioned": True}


@router.delete("/{device_id}/mqtt-credentials")
async def remove_mqtt_credentials(device_id: str) -> dict:
    try:
        await deprovision_device(device_id)
    except DynsecUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"deviceId": device_id, "provisioned": False}
