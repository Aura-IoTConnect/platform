"""Bridges the Mosquitto broker (infra/mosquitto.conf, docker-compose.yml)
into the same ingest_reading() pipeline used by POST /ingestion/telemetry.

Topic convention: `telemetry/<device_id>/<metric>`, JSON payload
`{"value": <float>, "unit": <str, optional>}`.

The broker requires a username/password, managed by Mosquitto's
dynamic-security plugin (app/mqtt_dynsec.py) — most devices get their own
provisioned credential (username=device_id), matching the HTTP ingestion
path's per-device Device.apiKeyHash; MQTT_USERNAME/MQTT_PASSWORD below is
the shared fallback credential apps/workers' own bridge connects with (it
needs telemetry-subscriber, not just device-publisher, to actually read
messages). See CLAUDE.md.

paho-mqtt's callbacks run on a background network thread, not the asyncio
event loop FastAPI/SQLAlchemy need — every message is handed off to the main
loop via `asyncio.run_coroutine_threadsafe`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

import paho.mqtt.client as mqtt

from app.telemetry_service import ingest_reading

logger = logging.getLogger("mqtt")

TOPIC_PATTERN = "telemetry/#"


class MqttBridge:
    def __init__(self) -> None:
        self._client: Optional[mqtt.Client] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        host = os.environ.get("MQTT_HOST", "localhost")
        port = int(os.environ.get("MQTT_PORT", "1883"))
        self._loop = loop

        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        client.on_connect = self._on_connect
        client.on_message = self._on_message

        username = os.environ.get("MQTT_USERNAME")
        password = os.environ.get("MQTT_PASSWORD")
        if username:
            client.username_pw_set(username, password)

        try:
            client.connect(host, port, keepalive=30)
        except (OSError, ConnectionRefusedError) as exc:
            logger.warning(
                "MQTT broker unreachable at %s:%s (%s) — MQTT telemetry ingestion disabled, "
                "HTTP POST /ingestion/telemetry still works",
                host,
                port,
                exc,
            )
            return

        client.loop_start()
        self._client = client
        logger.info("MQTT bridge connected to %s:%s, subscribed to %s", host, port, TOPIC_PATTERN)

    def stop(self) -> None:
        if self._client is not None:
            self._client.loop_stop()
            self._client.disconnect()
            self._client = None

    def _on_connect(self, client: mqtt.Client, _userdata, _flags, reason_code, _properties=None) -> None:
        if reason_code != 0:
            # connect() itself only raises on network-level failures — a
            # rejected CONNACK (e.g. bad credentials) only surfaces here.
            logger.warning("MQTT connect rejected by broker: %s — MQTT ingestion disabled", reason_code)
            return
        client.subscribe(TOPIC_PATTERN)

    def _on_message(self, _client: mqtt.Client, _userdata, msg) -> None:
        parts = msg.topic.split("/")
        if len(parts) != 3:
            logger.warning("ignoring message on unexpected topic=%s", msg.topic)
            return
        _, device_id, metric = parts

        try:
            payload = json.loads(msg.payload.decode())
            value = float(payload["value"])
            unit = payload.get("unit")
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            logger.warning("malformed MQTT telemetry payload on topic=%s: %s", msg.topic, exc)
            return

        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(ingest_reading(device_id, metric, value, unit=unit), self._loop)


mqtt_bridge = MqttBridge()
