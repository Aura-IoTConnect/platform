from dotenv import load_dotenv

load_dotenv()

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.actuator_routes import router as actuator_router
from app.agents_routes import router as agents_router
from app.ingestion import router as ingestion_router
from app.mqtt_client import mqtt_bridge


@asynccontextmanager
async def lifespan(_app: FastAPI):
    mqtt_bridge.start(asyncio.get_event_loop())
    yield
    mqtt_bridge.stop()


# Nothing calls this from a browser anymore — apps/api proxies agent
# triggers server-side (POST /api/agents/{key}/run), and telemetry ingestion
# is for devices/simulators, not dashboard JS. No CORS middleware needed.
app = FastAPI(title="iotplatform-workers", lifespan=lifespan)
app.include_router(ingestion_router)
app.include_router(agents_router)
app.include_router(actuator_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
