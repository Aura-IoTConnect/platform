"""Self-service device provisioning — a device creates its own `Device` row
and gets its own `apiKey` by presenting a `DeviceType`-level provisioning
credential, instead of an operator creating the `Device` row by hand first
(previously the only way to onboard a device). See CLAUDE.md's "Self-service
device provisioning" section.

Mirrors apps/api/src/routes/devices.ts's `POST /api/devices` as closely as
possible (same apiKey shape/hash, same best-effort MQTT provisioning) so a
self-provisioned device is indistinguishable from an operator-created one
afterward. This is the one place apps/workers creates a `Device` row rather
than only reading/updating existing ones — still consistent with CLAUDE.md's
schema-ownership rule, which is about DDL (Prisma owns migrations), not
about which service may insert rows into an already-migrated table; workers
already inserts into `alerts`/`actuator_commands`/etc.

Split the same way as telemetry_service.py/rule_engine.py: `_provision` is
the pure, testable logic (takes an existing connection, no network I/O) and
`provision_device_self_service` is the entry point that owns the
transaction and does the post-commit MQTT provisioning (real I/O, so it
must not hold the DB connection open — same reasoning as webhook/AI-agent
dispatch elsewhere in this project).
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from app.db import device_types, devices, get_engine, new_id
from app.mqtt_dynsec import DynsecUnavailable, provision_device


class InvalidProvisioningCredentials(Exception):
    pass


def _generate_key() -> str:
    # Mirrors apps/api/src/apiKeys.ts's generateApiKey() (same entropy and
    # hex format) so a self-provisioned device's apiKey is indistinguishable
    # from one apps/api hands out at creation time.
    return secrets.token_hex(24)


def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


async def _provision(
    conn: AsyncConnection,
    provision_key: str,
    provision_secret: str,
    device_name: str,
    location: Optional[str],
) -> tuple[str, str]:
    """Returns (device_id, raw api_key). Raises InvalidProvisioningCredentials
    on a bad/unconfigured key or a wrong secret."""

    device_type = (
        await conn.execute(select(device_types).where(device_types.c.provision_key == provision_key))
    ).mappings().first()

    # Same error for "no such key" and "key exists but provisioning was
    # never configured" (secret hash null) — don't let a caller distinguish
    # "wrong key" from "right key, not provisioned".
    if device_type is None or not device_type["provision_secret_hash"]:
        raise InvalidProvisioningCredentials("unknown or unconfigured provisioning key")

    if _hash_key(provision_secret) != device_type["provision_secret_hash"]:
        raise InvalidProvisioningCredentials("invalid provisioning secret")

    api_key = _generate_key()
    device_id = new_id()
    await conn.execute(
        devices.insert().values(
            id=device_id,
            device_type_id=device_type["id"],
            name=device_name,
            location=location,
            status="ONLINE",
            metadata=None,
            api_key_hash=_hash_key(api_key),
            created_at=datetime.now(timezone.utc),
        )
    )
    return device_id, api_key


async def provision_device_self_service(
    provision_key: str,
    provision_secret: str,
    device_name: str,
    location: Optional[str] = None,
) -> dict:
    engine = get_engine()
    async with engine.begin() as conn:
        device_id, api_key = await _provision(conn, provision_key, provision_secret, device_name, location)

    mqtt_provisioned = False
    try:
        await provision_device(device_id, api_key)
        mqtt_provisioned = True
    except DynsecUnavailable:
        pass  # best-effort, matches apps/api's devices.ts provisioning call

    return {"deviceId": device_id, "apiKey": api_key, "mqttProvisioned": mqtt_provisioned}
