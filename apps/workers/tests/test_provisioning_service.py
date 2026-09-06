"""Integration tests against the real dev Postgres (already migrated by
apps/api/prisma). Each test runs inside a transaction that's rolled back at
the end, so nothing here touches the seeded data.

Tests app/provisioning_service.py's `_provision` — the pure, connection-
taking logic — not `provision_device_self_service`, which additionally does
a real MQTT round-trip after commit (covered live, not here; see
apps/workers/tests/test_mqtt_dynsec.py for dynsec-specific coverage)."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.db import device_types, devices, dispose_engine, get_engine, new_id, verticals
from app.provisioning_service import InvalidProvisioningCredentials, _provision


@pytest.fixture
async def db_conn():
    engine = get_engine()
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            yield conn
        finally:
            await trans.rollback()
    await dispose_engine()


async def _seed_device_type(conn, *, provision_key=None, provision_secret_hash=None):
    vertical_id = new_id()
    device_type_id = new_id()
    now = datetime.now(timezone.utc)

    await conn.execute(
        verticals.insert().values(
            id=vertical_id, key=f"test-{vertical_id}", name="Test Vertical", description="test", created_at=now
        )
    )
    await conn.execute(
        device_types.insert().values(
            id=device_type_id,
            vertical_id=vertical_id,
            key="test-type",
            name="Test Type",
            description="test",
            metrics=[],
            created_at=now,
            provision_key=provision_key,
            provision_secret_hash=provision_secret_hash,
        )
    )
    return device_type_id


async def test_provision_creates_device_with_matching_credentials(db_conn):
    secret_hash = hashlib.sha256(b"correct-secret").hexdigest()
    device_type_id = await _seed_device_type(db_conn, provision_key="pk-1", provision_secret_hash=secret_hash)

    device_id, api_key = await _provision(db_conn, "pk-1", "correct-secret", "New Sensor", None)

    assert device_id
    assert len(api_key) == 48  # 24 raw bytes, hex-encoded — matches apps/api's generateApiKey()

    row = (await db_conn.execute(select(devices).where(devices.c.id == device_id))).mappings().first()
    assert row is not None
    assert row["device_type_id"] == device_type_id
    assert row["name"] == "New Sensor"
    assert row["status"] == "ONLINE"
    assert row["api_key_hash"] == hashlib.sha256(api_key.encode()).hexdigest()


async def test_provision_rejects_wrong_secret(db_conn):
    secret_hash = hashlib.sha256(b"correct-secret").hexdigest()
    await _seed_device_type(db_conn, provision_key="pk-2", provision_secret_hash=secret_hash)

    with pytest.raises(InvalidProvisioningCredentials):
        await _provision(db_conn, "pk-2", "wrong-secret", "New Sensor", None)


async def test_provision_rejects_unknown_key(db_conn):
    with pytest.raises(InvalidProvisioningCredentials):
        await _provision(db_conn, "does-not-exist", "anything", "New Sensor", None)


async def test_provision_rejects_device_type_with_provisioning_not_configured(db_conn):
    # provision_key set, but provision_secret_hash left null — provisioning
    # was never actually enabled for this device type via
    # POST /api/device-types/:id/provisioning-secret.
    await _seed_device_type(db_conn, provision_key="pk-3", provision_secret_hash=None)

    with pytest.raises(InvalidProvisioningCredentials):
        await _provision(db_conn, "pk-3", "anything", "New Sensor", None)


async def test_provision_stores_optional_location(db_conn):
    secret_hash = hashlib.sha256(b"s").hexdigest()
    await _seed_device_type(db_conn, provision_key="pk-4", provision_secret_hash=secret_hash)

    device_id, _ = await _provision(db_conn, "pk-4", "s", "New Sensor", "Roof — East Wing")

    row = (await db_conn.execute(select(devices).where(devices.c.id == device_id))).mappings().first()
    assert row["location"] == "Roof — East Wing"
