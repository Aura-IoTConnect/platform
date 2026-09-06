"""Admin client for Mosquitto's dynamic-security plugin — provisions a
per-device MQTT user (username=device_id, password=the same raw key
apps/api hands out for HTTP ingestion) whenever a device is created,
rotated, or soft-deleted, so MQTT auth matches the HTTP path's per-device
model instead of one shared broker credential for every publisher.

Speaks the documented JSON control-topic protocol directly via paho-mqtt
(https://mosquitto.org/documentation/dynamic-security/) rather than
shelling out to the mosquitto_ctrl CLI — apps/workers already depends on
paho-mqtt, and this has no dependency on the CLI (or Docker) being
available wherever apps/workers actually runs.

Bootstrap admin credentials: the plugin self-generates an `admin` user with
a random password on first boot, written to
infra/mosquitto-dynsec-state/dynamic-security.json.pw (bind-mounted, so
apps/workers — running natively on the host, not in Docker — can read it
directly; see docker-compose.yml). MQTT_DYNSEC_ADMIN_PASSWORD overrides this
if set, for anyone deploying somewhere that file isn't reachable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

import paho.mqtt.client as mqtt

logger = logging.getLogger("mqtt_dynsec")

CONTROL_TOPIC = "$CONTROL/dynamic-security/v1"
RESPONSE_TOPIC = "$CONTROL/dynamic-security/v1/response"
COMMAND_TIMEOUT_S = 10

# Per-device clients get publish-only rights, scoped to their own topic
# namespace via dynsec's %u substitution (%u = the connecting username,
# which is the device_id — see provision_device()) — a device can publish
# its own telemetry but not spoof another device's, and has no legitimate
# reason to subscribe to telemetry (its own or anyone else's) at all.
DEVICE_PUBLISHER_ROLE = "device-publisher"
DEVICE_PUBLISH_TOPIC_FILTER = "telemetry/%u/#"
# The shared fallback credential (MQTT_USERNAME/MQTT_PASSWORD, used by
# unprovisioned/demo devices and scripts/simulate_fleet.py) can't be scoped
# the same way — it legitimately publishes on behalf of many device_ids — so
# it gets its own unscoped role instead of device-publisher.
SHARED_PUBLISHER_ROLE = "shared-publisher"
# Also only ever assigned to the shared fallback credential, since
# apps/workers' own bridge (mqtt_client.py) subscribes using that same
# account to actually consume messages.
TELEMETRY_SUBSCRIBER_ROLE = "telemetry-subscriber"
TELEMETRY_TOPIC_FILTER = "telemetry/#"

# Auto-created by the plugin on first boot; nothing in this project uses it,
# and leaving a full-access demo account around is needless attack surface.
DEMO_CLIENT_USERNAME = "democlient"

_DEFAULT_PW_FILE = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "infra"
    / "mosquitto-dynsec-state"
    / "dynamic-security.json.pw"
)


class DynsecUnavailable(RuntimeError):
    pass


def _read_bootstrap_admin_password() -> Optional[str]:
    pw_file = Path(os.environ.get("MQTT_DYNSEC_PW_FILE", _DEFAULT_PW_FILE))
    try:
        for line in pw_file.read_text().splitlines():
            parts = line.split(" ", 1)
            if len(parts) == 2 and parts[0] == "admin":
                return parts[1]
    except FileNotFoundError:
        return None
    return None


def _admin_credentials() -> tuple[str, str]:
    password = os.environ.get("MQTT_DYNSEC_ADMIN_PASSWORD") or _read_bootstrap_admin_password()
    if not password:
        raise DynsecUnavailable(
            "No dynsec admin password available — set MQTT_DYNSEC_ADMIN_PASSWORD or make sure "
            "infra/mosquitto-dynsec-state/dynamic-security.json.pw exists (docker compose up mosquitto)."
        )
    return "admin", password


def _run_command_sync(command: dict[str, Any]) -> dict[str, Any]:
    """Blocking — always call via asyncio.to_thread. Opens a short-lived
    connection with the dynsec admin credentials, sends one command, waits
    for its correlated response, disconnects. Provisioning is infrequent
    (device create/rotate/delete), so a fresh connection per call is simpler
    than keeping a persistent admin session alive."""

    username, password = _admin_credentials()
    host = os.environ.get("MQTT_HOST", "localhost")
    port = int(os.environ.get("MQTT_PORT", "1883"))
    correlation_id = uuid.uuid4().hex
    command = {**command, "correlationData": correlation_id}

    result: dict[str, Any] = {}
    done = threading.Event()
    connect_failed = threading.Event()

    def on_connect(client: mqtt.Client, _userdata, _flags, reason_code, _properties=None) -> None:
        if reason_code != 0:
            connect_failed.set()
            done.set()
            return
        client.subscribe(RESPONSE_TOPIC)

    def on_subscribe(client: mqtt.Client, _userdata, _mid, _reason_codes, _properties=None) -> None:
        client.publish(CONTROL_TOPIC, json.dumps({"commands": [command]}))

    def on_message(_client: mqtt.Client, _userdata, msg) -> None:
        try:
            payload = json.loads(msg.payload.decode())
        except json.JSONDecodeError:
            return
        for response in payload.get("responses", []):
            if response.get("correlationData") == correlation_id:
                result.update(response)
                done.set()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.username_pw_set(username, password)
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message

    try:
        client.connect(host, port, keepalive=10)
    except (OSError, ConnectionRefusedError) as exc:
        raise DynsecUnavailable(f"MQTT broker unreachable at {host}:{port}: {exc}") from exc

    client.loop_start()
    try:
        if not done.wait(timeout=COMMAND_TIMEOUT_S):
            raise DynsecUnavailable(f"dynsec command timed out: {command.get('command')}")
        if connect_failed.is_set():
            raise DynsecUnavailable("dynsec admin connection rejected — check MQTT_DYNSEC_ADMIN_PASSWORD")
    finally:
        client.loop_stop()
        client.disconnect()

    return result


async def _run_command(command: dict[str, Any]) -> dict[str, Any]:
    result = await asyncio.to_thread(_run_command_sync, command)
    error = result.get("error")
    return {"error": error} if error else result


async def _run_idempotent(command: dict[str, Any], *acceptable_errors: str) -> None:
    result = await _run_command(command)
    error = result.get("error")
    if error and error not in acceptable_errors:
        raise DynsecUnavailable(f"{command['command']} failed: {error}")


async def _get_role(rolename: str) -> Optional[dict[str, Any]]:
    result = await _run_command({"command": "getRole", "rolename": rolename})
    if result.get("error"):
        return None
    return result.get("data", {}).get("role")


async def _get_client(username: str) -> Optional[dict[str, Any]]:
    result = await _run_command({"command": "getClient", "username": username})
    if result.get("error"):
        return None
    return result.get("data", {}).get("client")


async def ensure_bootstrap() -> None:
    """Safe to call on every apps/workers startup, but only ever does real
    work once — the roles this module depends on are static, so their mere
    existence (checked via getRole) means a previous run already finished.

    dynsec's error strings aren't reliably matchable for idempotency (e.g. a
    duplicate addClientRole reports the unhelpfully generic "Internal
    error"), so this checks state before mutating rather than trying to
    tolerate "already exists" errors after the fact.
    """
    if await _get_role(DEVICE_PUBLISHER_ROLE) is not None:
        logger.info("dynsec bootstrap already applied, skipping")
        return

    await _run_idempotent({"command": "createRole", "rolename": DEVICE_PUBLISHER_ROLE})
    await _run_idempotent(
        {
            "command": "addRoleACL",
            "rolename": DEVICE_PUBLISHER_ROLE,
            "acltype": "publishClientSend",
            "topic": DEVICE_PUBLISH_TOPIC_FILTER,
            "allow": True,
        }
    )

    await _run_idempotent({"command": "createRole", "rolename": SHARED_PUBLISHER_ROLE})
    await _run_idempotent(
        {
            "command": "addRoleACL",
            "rolename": SHARED_PUBLISHER_ROLE,
            "acltype": "publishClientSend",
            "topic": TELEMETRY_TOPIC_FILTER,
            "allow": True,
        }
    )

    await _run_idempotent({"command": "createRole", "rolename": TELEMETRY_SUBSCRIBER_ROLE})
    await _run_idempotent(
        {
            "command": "addRoleACL",
            "rolename": TELEMETRY_SUBSCRIBER_ROLE,
            "acltype": "subscribePattern",
            "topic": TELEMETRY_TOPIC_FILTER,
            "allow": True,
        }
    )

    await _run_idempotent({"command": "deleteClient", "username": DEMO_CLIENT_USERNAME}, "Client not found")

    shared_username = os.environ.get("MQTT_USERNAME")
    shared_password = os.environ.get("MQTT_PASSWORD")
    if shared_username and shared_password:
        await _run_idempotent({"command": "createClient", "username": shared_username, "password": shared_password})
        await _run_idempotent(
            {"command": "addClientRole", "username": shared_username, "rolename": SHARED_PUBLISHER_ROLE}
        )
        await _run_idempotent(
            {"command": "addClientRole", "username": shared_username, "rolename": TELEMETRY_SUBSCRIBER_ROLE}
        )
    else:
        logger.info("MQTT_USERNAME/MQTT_PASSWORD not set — skipping shared fallback credential provisioning")


async def provision_device(device_id: str, password: str) -> None:
    """Creates the device's MQTT user if it doesn't exist, and (either way)
    sets its password to `password` — so this same call covers both first
    provisioning and key rotation; the caller doesn't need to know which."""
    client = await _get_client(device_id)
    if client is None:
        await _run_idempotent({"command": "createClient", "username": device_id, "password": password})
    else:
        await _run_idempotent({"command": "setClientPassword", "username": device_id, "password": password})

    has_role = client is not None and any(r["rolename"] == DEVICE_PUBLISHER_ROLE for r in client.get("roles", []))
    if not has_role:
        await _run_idempotent({"command": "addClientRole", "username": device_id, "rolename": DEVICE_PUBLISHER_ROLE})


async def deprovision_device(device_id: str) -> None:
    await _run_idempotent({"command": "deleteClient", "username": device_id}, "Client not found")
