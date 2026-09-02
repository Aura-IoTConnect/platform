"""Integration test against the real dev Postgres, rolled back per test —
see test_rule_engine.py for the same pattern."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.actuator_service import dispatch_command
from app.db import actuator_commands, device_types, devices, dispose_engine, get_engine, new_id, verticals


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


async def _seed_device(conn):
    vertical_id = new_id()
    device_type_id = new_id()
    device_id = new_id()
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
    return device_id


async def test_dispatch_command_persists_manual_command(db_conn):
    device_id = await _seed_device(db_conn)

    result = await dispatch_command(db_conn, device_id, "turn_on_fan", value={"speed": 3}, source="MANUAL")

    assert result["command"] == "turn_on_fan"
    assert result["source"] == "MANUAL"

    row = (
        await db_conn.execute(select(actuator_commands).where(actuator_commands.c.id == result["id"]))
    ).mappings().first()
    assert row is not None
    assert row["device_id"] == device_id
    assert row["value"] == {"speed": 3}
    assert row["rule_id"] is None


async def test_dispatch_command_without_value(db_conn):
    device_id = await _seed_device(db_conn)

    result = await dispatch_command(db_conn, device_id, "ping", source="MANUAL")

    row = (
        await db_conn.execute(select(actuator_commands).where(actuator_commands.c.id == result["id"]))
    ).mappings().first()
    assert row["value"] is None
