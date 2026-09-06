from dotenv import load_dotenv

load_dotenv()

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.actuator_routes import router as actuator_router
from app.agents import maybe_trigger_anomaly_explainer
from app.agents_routes import router as agents_router
from app.backtest_routes import router as backtest_router
from app.db import get_engine
from app.device_mqtt_routes import router as device_mqtt_router
from app.ingestion import router as ingestion_router
from app.metrics import metrics_endpoint
from app.mqtt_client import mqtt_bridge
from app.mqtt_dynsec import DynsecUnavailable, ensure_bootstrap
from app.provisioning_routes import router as provisioning_router
from app.silence_monitor import check_silence_rules

logger = logging.getLogger("main")

# How often to check for silent devices (see app/silence_monitor.py) — a
# tradeoff between how quickly a genuinely stopped device gets noticed and
# how often we scan every enabled SILENT_FOR rule's devices. 60s is much
# finer than any sane silence threshold (minutes), so it doesn't add
# meaningful detection latency.
SILENCE_CHECK_INTERVAL_SECONDS = int(os.environ.get("SILENCE_CHECK_INTERVAL_SECONDS", "60"))


async def _silence_check_loop() -> None:
    engine = get_engine()
    while True:
        try:
            created = await check_silence_rules(engine)
            for alert in created:
                if alert["severity"] == "CRITICAL":
                    await maybe_trigger_anomaly_explainer(alert["id"])
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — one bad pass must not kill the loop
            logger.exception("silence check failed")
        await asyncio.sleep(SILENCE_CHECK_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        await ensure_bootstrap()
    except DynsecUnavailable as exc:
        # Best-effort, same as the MQTT bridge below: per-device MQTT
        # provisioning is unavailable until this succeeds (apps/api's calls
        # will get a 503), but HTTP ingestion and everything else works.
        logger.warning("dynsec bootstrap failed — per-device MQTT auth unavailable: %s", exc)

    mqtt_bridge.start(asyncio.get_event_loop())
    silence_task = asyncio.create_task(_silence_check_loop())
    yield
    silence_task.cancel()
    mqtt_bridge.stop()


# Nothing calls this from a browser anymore — apps/api proxies agent
# triggers server-side (POST /api/agents/{key}/run), and telemetry ingestion
# is for devices/simulators, not dashboard JS. No CORS middleware needed.
app = FastAPI(title="iotplatform-workers", lifespan=lifespan)
app.include_router(ingestion_router)
app.include_router(agents_router)
app.include_router(actuator_router)
app.include_router(device_mqtt_router)
app.include_router(provisioning_router)
app.include_router(backtest_router)
# Prometheus exposition for this service (see app/metrics.py). Left open like
# /health — ops data, no device or user data.
app.add_api_route("/metrics", metrics_endpoint, methods=["GET"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
