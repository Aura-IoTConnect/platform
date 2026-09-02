"""Simulated device fleet: publishes plausible telemetry over MQTT for every
seeded device on a timer, using each device type's metric ranges from
apps/api/prisma/seed.ts. Useful for seeing the dashboard, rule engine, and
agents react without wiring up real hardware.

Usage (from apps/workers, with the venv active):
    python -m scripts.simulate_fleet [--interval 5]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random

from dotenv import load_dotenv

load_dotenv()

import paho.mqtt.client as mqtt
from sqlalchemy import select

from app.db import device_types, devices, get_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("simulate_fleet")


async def load_fleet():
    engine = get_engine()
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                select(devices.c.id, devices.c.name, device_types.c.metrics).select_from(
                    devices.join(device_types, devices.c.device_type_id == device_types.c.id)
                )
            )
        ).all()
    return rows


def random_value(metric: dict) -> float:
    lo = metric.get("min", 0)
    hi = metric.get("max", lo + 100)
    # Occasionally simulate an out-of-range excursion so seeded rules actually fire.
    if random.random() < 0.08:
        span = max(hi - lo, 1)
        return round(random.uniform(lo - span * 0.2, hi + span * 0.2), 2)
    return round(random.uniform(lo, hi), 2)


async def run(interval: float) -> None:
    host = os.environ.get("MQTT_HOST", "localhost")
    port = int(os.environ.get("MQTT_PORT", "1883"))

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    username = os.environ.get("MQTT_USERNAME")
    password = os.environ.get("MQTT_PASSWORD")
    if username:
        client.username_pw_set(username, password)
    client.connect(host, port, keepalive=30)
    client.loop_start()

    fleet = await load_fleet()
    if not fleet:
        logger.warning("no devices found — run `npm run db:seed --workspace=apps/api` first")
        client.loop_stop()
        client.disconnect()
        return

    logger.info(
        "simulating telemetry for %d devices every %ss (topic: telemetry/<device_id>/<metric>)",
        len(fleet),
        interval,
    )

    try:
        while True:
            for device_id, _name, metrics in fleet:
                for metric in metrics:
                    value = random_value(metric)
                    topic = f"telemetry/{device_id}/{metric['key']}"
                    payload = json.dumps({"value": value, "unit": metric.get("unit")})
                    client.publish(topic, payload)
            logger.info("published one round of readings for %d devices", len(fleet))
            await asyncio.sleep(interval)
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between rounds")
    args = parser.parse_args()
    asyncio.run(run(args.interval))


if __name__ == "__main__":
    main()
