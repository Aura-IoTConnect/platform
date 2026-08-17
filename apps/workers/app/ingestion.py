from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.security import require_workers_token
from app.telemetry_service import ingest_reading

router = APIRouter(prefix="/ingestion", tags=["ingestion"], dependencies=[Depends(require_workers_token)])


class TelemetryReading(BaseModel):
    device_id: str
    metric: str
    value: float
    unit: Optional[str] = None
    timestamp: Optional[datetime] = None


@router.post("/telemetry")
async def ingest_telemetry(reading: TelemetryReading) -> dict:
    return await ingest_reading(
        reading.device_id, reading.metric, reading.value, unit=reading.unit, timestamp=reading.timestamp
    )
