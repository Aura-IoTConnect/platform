"""Integration tests against the real dev Postgres, rolled back per test —
same fixture as test_rule_engine.py. Real seeded data (e.g. the
weather-station's own SILENT_FOR rule) is visible inside the transaction
too, so assertions filter to each test's own device/rule id rather than
asserting a global count."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.db import actuator_commands, alerts, device_types, devices, dispose_engine, get_engine, new_id, rules, verticals
from app.rule_engine import evaluate
from app.silence_monitor import _check_silence_rules

NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)


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


async def _seed_device_with_silence_rule(
    conn, *, threshold=30, severity="WARNING", action_type="notify", action_config=None, metric="temperature"
):
    vertical_id, device_type_id, device_id, rule_id = new_id(), new_id(), new_id(), new_id()
    await conn.execute(
        verticals.insert().values(id=vertical_id, key=f"t-{vertical_id}", name="V", description="d", created_at=NOW)
    )
    await conn.execute(
        device_types.insert().values(
            id=device_type_id, vertical_id=vertical_id, key="t", name="T", description="d", metrics=[], created_at=NOW
        )
    )
    await conn.execute(
        devices.insert().values(
            id=device_id, device_type_id=device_type_id, name="D", location=None, status="ONLINE", metadata=None, created_at=NOW
        )
    )
    await conn.execute(
        rules.insert().values(
            id=rule_id,
            device_type_id=device_type_id,
            name="Silence rule",
            metric=metric,
            operator="SILENT_FOR",
            threshold=threshold,
            severity=severity,
            action_type=action_type,
            action_config=action_config,
            enabled=True,
            created_at=NOW,
        )
    )
    return device_id, rule_id


async def _insert_reading(conn, device_id, minutes_ago, metric="temperature"):
    from app.db import telemetry_readings

    await conn.execute(
        telemetry_readings.insert().values(
            id=new_id(),
            device_id=device_id,
            metric=metric,
            value=20.0,
            unit=None,
            timestamp=NOW - timedelta(minutes=minutes_ago),
        )
    )


def _for_rule(created, rule_id):
    return [c for c in created if c["ruleId"] == rule_id]


async def test_device_with_no_readings_ever_is_flagged(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(db_conn)
    created = await _check_silence_rules(db_conn, NOW)
    mine = _for_rule(created, rule_id)
    assert len(mine) == 1 and mine[0]["deviceId"] == device_id


async def test_recent_reading_is_not_flagged(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(db_conn, threshold=30)
    await _insert_reading(db_conn, device_id, minutes_ago=5)
    created = await _check_silence_rules(db_conn, NOW)
    assert _for_rule(created, rule_id) == []


async def test_stale_reading_is_flagged(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(db_conn, threshold=30)
    await _insert_reading(db_conn, device_id, minutes_ago=45)
    created = await _check_silence_rules(db_conn, NOW)
    assert len(_for_rule(created, rule_id)) == 1


async def test_second_pass_does_not_duplicate_the_alert(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(db_conn)
    first = await _check_silence_rules(db_conn, NOW)
    second = await _check_silence_rules(db_conn, NOW + timedelta(minutes=1))
    assert len(_for_rule(first, rule_id)) == 1
    assert _for_rule(second, rule_id) == []

    rows = (await db_conn.execute(select(alerts).where(alerts.c.rule_id == rule_id))).all()
    assert len(rows) == 1


async def test_actuator_action_dispatches_command(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(
        db_conn, action_type="actuator", action_config={"command": "sound_horn"}
    )
    await _check_silence_rules(db_conn, NOW)
    row = (
        await db_conn.execute(select(actuator_commands).where(actuator_commands.c.rule_id == rule_id))
    ).mappings().first()
    assert row is not None and row["command"] == "sound_horn" and row["source"] == "RULE"


async def test_disabled_rule_is_ignored(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(db_conn)
    await db_conn.execute(rules.update().where(rules.c.id == rule_id).values(enabled=False))
    created = await _check_silence_rules(db_conn, NOW)
    assert _for_rule(created, rule_id) == []


async def test_new_reading_auto_clears_the_open_silence_alert(db_conn):
    device_id, rule_id = await _seed_device_with_silence_rule(db_conn)
    await _check_silence_rules(db_conn, NOW)

    before = (await db_conn.execute(select(alerts).where(alerts.c.rule_id == rule_id))).mappings().first()
    assert before["status"] == "OPEN"

    # A fresh reading for the watched metric arrives through the normal
    # per-reading path — evaluate() should resolve the silence alert.
    await evaluate(db_conn, device_id, "temperature", 21.0)
    after = (await db_conn.execute(select(alerts).where(alerts.c.rule_id == rule_id))).mappings().first()
    assert after["status"] == "RESOLVED" and after["resolved_at"] is not None
