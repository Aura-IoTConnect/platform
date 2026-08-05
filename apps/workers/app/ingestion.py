from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


class TelemetryReading(BaseModel):
    device_id: str
    metric: str
    value: float
    timestamp: str


@router.post("/telemetry")
def ingest_telemetry(reading: TelemetryReading) -> dict[str, str]:
    # TODO: persist reading and forward to the processing pipeline
    return {"status": "accepted"}
