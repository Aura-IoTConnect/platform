"""Integration tests for the liveness signal (Device.last_seen_at) — see
CLAUDE.md's "Liveness signal & Devices tab search" section.

Unlike test_rule_engine.py's db_conn fixture, `ingest_reading` and
`record_heartbeat` open and commit their own transaction internally (they're
the top-level entry points for HTTP/MQTT handlers, not connection-taking
helpers) — the same reason test_provisioning_service.py tests `_provision`
(connection-taking) rather than `provision_device_self_service` (opens its
own transaction, "covered live"). There's no lower-level split to test here
without changing ingest_reading's signature, so this seeds/cleans up real,
committed rows instead of relying on a rollback, mirroring the
create-then-delete convention used throughout apps/api's vitest tests."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.db import device_types, devices, dispose_engine, get_engine, new_id, telemetry_readings, verticals
from app.telemetry_service import ingest_reading, record_heartbeat


@pytest.fixture
async def seeded_device():
    engine = get_engine()
    vertical_id, device_type_id, device_id = new_id(), new_id(), new_id()
    now = datetime.now(timezone.utc)
    async with engine.begin() as conn:
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
                metrics=[{"key": "temperature", "min": 0, "max": 100, "onOutOfRange": "reject"}],
                created_at=now,
            )
        )
        await conn.execute(
            devices.insert().values(
                id=device_id,
                device_type_id=device_type_id,
                name="Test Device",
                location=None,
                status="ONLINE",
                metadata=None,
                created_at=now,
            )
        )
    try:
        yield device_id
    finally:
        async with engine.begin() as conn:
            await conn.execute(devices.delete().where(devices.c.id == device_id))
            await conn.execute(device_types.delete().where(device_types.c.id == device_type_id))
            await conn.execute(verticals.delete().where(verticals.c.id == vertical_id))
    await dispose_engine()


async def _last_seen_at(device_id):
    engine = get_engine()
    async with engine.connect() as conn:
        row = (await conn.execute(select(devices.c.last_seen_at).where(devices.c.id == device_id))).first()
    return row.last_seen_at


async def test_ingest_reading_stamps_last_seen_at(seeded_device):
    assert await _last_seen_at(seeded_device) is None

    result = await ingest_reading(seeded_device, "temperature", 50.0)

    assert result["status"] == "accepted"
    last_seen = await _last_seen_at(seeded_device)
    assert last_seen is not None
    assert (datetime.now(timezone.utc) - last_seen.replace(tzinfo=timezone.utc)).total_seconds() < 30


async def test_ingest_reading_stamps_last_seen_at_even_when_rejected(seeded_device):
    result = await ingest_reading(seeded_device, "temperature", 999.0)

    assert result["status"] == "rejected"
    assert await _last_seen_at(seeded_device) is not None


async def test_record_heartbeat_stamps_last_seen_at_without_a_telemetry_row(seeded_device):
    seen = await record_heartbeat(seeded_device)

    assert seen is True
    assert await _last_seen_at(seeded_device) is not None

    engine = get_engine()
    async with engine.connect() as conn:
        row = (
            await conn.execute(select(telemetry_readings).where(telemetry_readings.c.device_id == seeded_device))
        ).first()
    assert row is None


async def test_record_heartbeat_returns_false_for_unknown_device():
    assert await record_heartbeat("does-not-exist") is False
