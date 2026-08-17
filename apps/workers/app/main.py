from dotenv import load_dotenv

load_dotenv()

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agents_routes import router as agents_router
from app.ingestion import router as ingestion_router
from app.mqtt_client import mqtt_bridge


@asynccontextmanager
async def lifespan(_app: FastAPI):
    mqtt_bridge.start(asyncio.get_event_loop())
    yield
    mqtt_bridge.stop()


app = FastAPI(title="iotplatform-workers", lifespan=lifespan)
# Trigger endpoints are called directly from the dashboard's browser JS.
# Not behind apps/api's JWT auth — see CLAUDE.md for the auth boundary.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(ingestion_router)
app.include_router(agents_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
