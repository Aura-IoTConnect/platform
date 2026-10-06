"""Tests for app/security.py — the device-key / shared-token auth that gates
every apps/workers HTTP endpoint — plus the ingestion routes that depend on
it (app/ingestion.py).

Route handlers are awaited directly rather than through FastAPI's
TestClient: TestClient runs the app on its own event loop, and the shared
asyncpg engine (app/db.py::get_engine) is bound to whichever loop first used
it, so mixing the two loops in one test process fails. Calling the coroutines
exercises the same auth + route logic on pytest-asyncio's loop.

Like test_telemetry_service.py, check_device_auth opens its own connection,
so fixtures here seed and clean up real, committed rows rather than relying on
a rollback."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.db import device_types, devices, dispose_engine, get_engine, new_id, verticals
from app.ingestion import Heartbeat, TelemetryReading, ingest_heartbeat, ingest_telemetry
from app.security import _secrets_equal, check_device_auth, require_workers_token

DEVICE_KEY = "test-device-key-abc123"
SHARED_TOKEN = "test-shared-token-xyz789"


@pytest.fixture(autouse=True)
async def _dispose_engine_after_each_test():
    # Every test runs on its own event loop, but get_engine() caches one
    # asyncpg pool. Tests that call check_device_auth without the `seeded`
    # fixture would otherwise leave a pool bound to a loop that's about to
    # close, breaking the next test's teardown.
    yield
    await dispose_engine()


@pytest.fixture
async def seeded():
    """One device WITH a per-device key, one WITHOUT (falls back to the shared
    token). The device type rejects out-of-range temperature readings."""
    engine = get_engine()
    vertical_id, device_type_id = new_id(), new_id()
    keyed_id, keyless_id = new_id(), new_id()
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
        for device_id, key_hash in (
            (keyed_id, hashlib.sha256(DEVICE_KEY.encode()).hexdigest()),
            (keyless_id, None),
        ):
            await conn.execute(
                devices.insert().values(
                    id=device_id,
                    device_type_id=device_type_id,
                    name="Test Device",
                    location=None,
                    status="ONLINE",
                    metadata=None,
                    api_key_hash=key_hash,
                    created_at=now,
                )
            )
    try:
        yield {"keyed": keyed_id, "keyless": keyless_id}
    finally:
        async with engine.begin() as conn:
            await conn.execute(devices.delete().where(devices.c.device_type_id == device_type_id))
            await conn.execute(device_types.delete().where(device_types.c.id == device_type_id))
            await conn.execute(verticals.delete().where(verticals.c.id == vertical_id))
    await dispose_engine()


# --- _secrets_equal ---------------------------------------------------------


def test_secrets_equal_matches_only_identical_values():
    assert _secrets_equal("abc", "abc")
    assert not _secrets_equal("abc", "abd")
    assert not _secrets_equal("abc", "abcd")  # different lengths must not raise or match
    assert not _secrets_equal(None, "abc")
    assert not _secrets_equal("", "abc")


# --- require_workers_token --------------------------------------------------


async def test_workers_token_is_open_when_unset(monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    await require_workers_token(authorization=None)  # dev default: no check


async def test_workers_token_accepts_the_right_bearer(monkeypatch):
    monkeypatch.setenv("WORKERS_API_TOKEN", SHARED_TOKEN)
    await require_workers_token(authorization=f"Bearer {SHARED_TOKEN}")


@pytest.mark.parametrize("header", [None, "", "Bearer wrong", "Basic abc", SHARED_TOKEN])
async def test_workers_token_rejects_everything_else(monkeypatch, header):
    monkeypatch.setenv("WORKERS_API_TOKEN", SHARED_TOKEN)
    with pytest.raises(HTTPException) as exc:
        await require_workers_token(authorization=header)
    assert exc.value.status_code == 401


# --- check_device_auth ------------------------------------------------------


async def test_device_with_a_key_accepts_only_its_own_key(seeded, monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    await check_device_auth(seeded["keyed"], f"Bearer {DEVICE_KEY}")

    for header in (None, "Bearer wrong-key", "Basic abc"):
        with pytest.raises(HTTPException) as exc:
            await check_device_auth(seeded["keyed"], header)
        assert exc.value.status_code == 401


async def test_per_device_key_is_not_replaced_by_the_shared_token(seeded, monkeypatch):
    # A device that has its own key must NOT accept the shared token.
    monkeypatch.setenv("WORKERS_API_TOKEN", SHARED_TOKEN)
    with pytest.raises(HTTPException) as exc:
        await check_device_auth(seeded["keyed"], f"Bearer {SHARED_TOKEN}")
    assert exc.value.status_code == 401


async def test_keyless_device_falls_back_to_the_shared_token(seeded, monkeypatch):
    monkeypatch.setenv("WORKERS_API_TOKEN", SHARED_TOKEN)
    await check_device_auth(seeded["keyless"], f"Bearer {SHARED_TOKEN}")

    for header in (None, "Bearer wrong"):
        with pytest.raises(HTTPException) as exc:
            await check_device_auth(seeded["keyless"], header)
        assert exc.value.status_code == 401


async def test_keyless_device_is_open_when_no_shared_token_is_configured(seeded, monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    await check_device_auth(seeded["keyless"], None)


async def test_unknown_device_defers_to_the_handler(monkeypatch):
    monkeypatch.setenv("WORKERS_API_TOKEN", SHARED_TOKEN)
    # Auth deliberately doesn't fail for an unknown id; the route's own
    # lookup produces the clean unknown_device / 404 outcome instead.
    await check_device_auth("does-not-exist", None)


# --- ingestion routes -------------------------------------------------------


async def test_telemetry_route_rejects_a_bad_key_before_ingesting(seeded, monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    reading = TelemetryReading(device_id=seeded["keyed"], metric="temperature", value=50.0)
    with pytest.raises(HTTPException) as exc:
        await ingest_telemetry(reading, authorization="Bearer wrong-key")
    assert exc.value.status_code == 401


async def test_telemetry_route_accepts_a_good_key(seeded, monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    reading = TelemetryReading(device_id=seeded["keyed"], metric="temperature", value=50.0)
    result = await ingest_telemetry(reading, authorization=f"Bearer {DEVICE_KEY}")
    assert result["status"] == "accepted"


async def test_telemetry_route_surfaces_a_policy_rejection_as_422(seeded, monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    reading = TelemetryReading(device_id=seeded["keyed"], metric="temperature", value=9999.0)
    with pytest.raises(HTTPException) as exc:
        await ingest_telemetry(reading, authorization=f"Bearer {DEVICE_KEY}")
    assert exc.value.status_code == 422


async def test_heartbeat_route_auth_and_unknown_device(seeded, monkeypatch):
    monkeypatch.delenv("WORKERS_API_TOKEN", raising=False)
    ok = await ingest_heartbeat(Heartbeat(device_id=seeded["keyed"]), authorization=f"Bearer {DEVICE_KEY}")
    assert ok == {"status": "ok"}

    with pytest.raises(HTTPException) as bad:
        await ingest_heartbeat(Heartbeat(device_id=seeded["keyed"]), authorization="Bearer nope")
    assert bad.value.status_code == 401

    with pytest.raises(HTTPException) as missing:
        await ingest_heartbeat(Heartbeat(device_id="does-not-exist"), authorization=None)
    assert missing.value.status_code == 404
