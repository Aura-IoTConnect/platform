from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.agents import maybe_trigger_anomaly_explainer
from app.db import get_engine, new_id, telemetry_readings
from app.rule_engine import evaluate

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


class TelemetryReading(BaseModel):
    device_id: str
    metric: str
    value: float
    unit: Optional[str] = None
    timestamp: Optional[datetime] = None


@router.post("/telemetry")
async def ingest_telemetry(reading: TelemetryReading) -> dict:
    timestamp = reading.timestamp or datetime.now(timezone.utc)

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            telemetry_readings.insert().values(
                id=new_id(),
                device_id=reading.device_id,
                metric=reading.metric,
                value=reading.value,
                unit=reading.unit,
                timestamp=timestamp,
            )
        )

        created_alerts = await evaluate(conn, reading.device_id, reading.metric, reading.value)

    for alert in created_alerts:
        if alert["severity"] == "CRITICAL":
            await maybe_trigger_anomaly_explainer(alert["id"])

    return {"status": "accepted", "alertsCreated": len(created_alerts)}
