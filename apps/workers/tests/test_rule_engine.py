"""Integration tests against the real dev Postgres (already migrated by
apps/api/prisma). Each test runs inside a transaction that's rolled back at
the end, so nothing here touches the seeded data."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.db import alerts, device_types, devices, dispose_engine, get_engine, new_id, rules, verticals
from app.rule_engine import evaluate


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


async def _seed_device_with_rule(conn, *, operator: str, threshold: float, severity: str = "CRITICAL"):
    vertical_id = new_id()
    device_type_id = new_id()
    device_id = new_id()
    rule_id = new_id()
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
    await conn.execute(
        rules.insert().values(
            id=rule_id,
            device_type_id=device_type_id,
            name="Test Rule",
            metric="temperature",
            operator=operator,
            threshold=threshold,
            severity=severity,
            action_type="notify",
            action_config=None,
            enabled=True,
            created_at=now,
        )
    )
    return device_id, rule_id


async def test_evaluate_creates_alert_on_breach(db_conn):
    device_id, rule_id = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)

    created = await evaluate(db_conn, device_id, "temperature", 15.0)

    assert len(created) == 1
    assert created[0]["ruleId"] == rule_id
    assert created[0]["severity"] == "CRITICAL"

    row = (
        await db_conn.execute(select(alerts).where(alerts.c.device_id == device_id))
    ).mappings().first()
    assert row is not None
    assert row["status"] == "OPEN"


async def test_evaluate_no_breach_creates_no_alert(db_conn):
    device_id, _ = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)

    created = await evaluate(db_conn, device_id, "temperature", 5.0)

    assert created == []
    row = (
        await db_conn.execute(select(alerts).where(alerts.c.device_id == device_id))
    ).mappings().first()
    assert row is None


async def test_evaluate_disabled_rule_is_ignored(db_conn):
    device_id, rule_id = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)
    await db_conn.execute(rules.update().where(rules.c.id == rule_id).values(enabled=False))

    created = await evaluate(db_conn, device_id, "temperature", 15.0)

    assert created == []


async def test_evaluate_unknown_device_returns_empty(db_conn):
    created = await evaluate(db_conn, "does-not-exist", "temperature", 100.0)
    assert created == []


async def test_evaluate_ignores_other_metrics(db_conn):
    device_id, _ = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)

    created = await evaluate(db_conn, device_id, "humidity", 999.0)

    assert created == []
