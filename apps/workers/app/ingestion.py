from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.security import check_device_auth
from app.telemetry_service import ingest_reading, record_heartbeat

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


class TelemetryReading(BaseModel):
    device_id: str
    metric: str
    value: float
    unit: Optional[str] = None
    timestamp: Optional[datetime] = None


class Heartbeat(BaseModel):
    device_id: str


@router.post("/telemetry")
async def ingest_telemetry(reading: TelemetryReading, authorization: Optional[str] = Header(default=None)) -> dict:
    # Auth is per-device (Device.apiKeyHash), not a single shared token, so
    # it needs reading.device_id — done here rather than as a router-level
    # dependency, which can't see the parsed body.
    await check_device_auth(reading.device_id, authorization)
    result = await ingest_reading(
        reading.device_id, reading.metric, reading.value, unit=reading.unit, timestamp=reading.timestamp
    )
    if result["status"] == "rejected":
        # The device type's metric policy (app/metric_pipeline.py) refused
        # this value — surface it to the sender rather than silently dropping.
        raise HTTPException(status_code=422, detail=f"reading rejected: {result['reason']}")
    return result


# A liveness signal distinct from telemetry — for a device with nothing to
# report right now that still wants to prove it's reachable. Same device
# auth as /ingestion/telemetry. See CLAUDE.md's "Liveness signal & Devices
# tab search" section.
@router.post("/heartbeat")
async def ingest_heartbeat(heartbeat: Heartbeat, authorization: Optional[str] = Header(default=None)) -> dict:
    await check_device_auth(heartbeat.device_id, authorization)
    seen = await record_heartbeat(heartbeat.device_id)
    if not seen:
        raise HTTPException(status_code=404, detail="Unknown device_id")
    return {"status": "ok"}
