"""Integration tests against the real dev Postgres (already migrated by
apps/api/prisma). Each test runs inside a transaction that's rolled back at
the end, so nothing here touches the seeded data."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.db import actuator_commands, alerts, device_types, devices, dispose_engine, get_engine, new_id, rules, verticals
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


async def _seed_device_with_rule(
    conn,
    *,
    operator: str,
    threshold: float,
    severity: str = "CRITICAL",
    action_type: str = "notify",
    action_config=None,
):
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
            action_type=action_type,
            action_config=action_config,
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


async def test_evaluate_actuator_rule_persists_actuator_command(db_conn):
    device_id, rule_id = await _seed_device_with_rule(
        db_conn,
        operator="GT",
        threshold=10.0,
        action_type="actuator",
        action_config={"command": "increase_compressor_duty"},
    )

    await evaluate(db_conn, device_id, "temperature", 15.0)

    row = (
        await db_conn.execute(select(actuator_commands).where(actuator_commands.c.device_id == device_id))
    ).mappings().first()
    assert row is not None
    assert row["command"] == "increase_compressor_duty"
    assert row["source"] == "RULE"
    assert row["rule_id"] == rule_id


async def test_evaluate_dedupes_repeat_breach(db_conn):
    device_id, _ = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)

    first = await evaluate(db_conn, device_id, "temperature", 15.0)
    second = await evaluate(db_conn, device_id, "temperature", 16.0)

    assert len(first) == 1
    assert second == []  # already alerting — no duplicate row, nothing "newly created"

    rows = (await db_conn.execute(select(alerts).where(alerts.c.device_id == device_id))).mappings().all()
    assert len(rows) == 1
    assert rows[0]["status"] == "OPEN"


async def test_evaluate_auto_clears_when_reading_recovers(db_conn):
    device_id, _ = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)

    await evaluate(db_conn, device_id, "temperature", 15.0)
    cleared = await evaluate(db_conn, device_id, "temperature", 5.0)

    assert cleared == []
    row = (await db_conn.execute(select(alerts).where(alerts.c.device_id == device_id))).mappings().first()
    assert row["status"] == "RESOLVED"
    assert row["resolved_at"] is not None


async def test_evaluate_recreates_alert_after_recovery_and_rebreach(db_conn):
    device_id, _ = await _seed_device_with_rule(db_conn, operator="GT", threshold=10.0)

    await evaluate(db_conn, device_id, "temperature", 15.0)  # episode 1: breach
    await evaluate(db_conn, device_id, "temperature", 5.0)  # recovers -> resolved

    # Push the resolved episode's last_notified_at into the past so this test
    # exercises the "cooldown elapsed" path without depending on (or having
    # to change) NOTIFY_COOLDOWN_SECONDS' 300s default.
    await db_conn.execute(
        alerts.update()
        .where(alerts.c.device_id == device_id)
        .values(last_notified_at=datetime.now(timezone.utc) - timedelta(seconds=400))
    )

    second_episode = await evaluate(db_conn, device_id, "temperature", 20.0)

    assert len(second_episode) == 1
    rows = (await db_conn.execute(select(alerts).where(alerts.c.device_id == device_id))).mappings().all()
    assert len(rows) == 2  # history preserved: resolved episode + new one
    assert sum(1 for r in rows if r["status"] == "OPEN") == 1


async def test_evaluate_webhook_rule_returns_pending_dispatch(db_conn):
    # evaluate() must not make the HTTP call itself (see rule_engine.py's
    # module docstring) — it hands back enough for the caller to dispatch
    # after its transaction commits.
    device_id, rule_id = await _seed_device_with_rule(
        db_conn,
        operator="GT",
        threshold=10.0,
        action_type="webhook",
        action_config={"url": "https://example.org/hooks/test"},
    )

    created = await evaluate(db_conn, device_id, "temperature", 15.0)

    assert len(created) == 1
    pending = created[0]["pendingWebhook"]
    assert pending is not None
    assert pending["url"] == "https://example.org/hooks/test"
    assert pending["payload"]["ruleId"] == rule_id
    assert pending["payload"]["value"] == 15.0


async def test_evaluate_notify_cooldown_suppresses_recent_repeat_episode(db_conn):
    device_id, _ = await _seed_device_with_rule(
        db_conn,
        operator="GT",
        threshold=10.0,
        action_type="webhook",
        action_config={"url": "https://example.org/hooks/test"},
    )

    await evaluate(db_conn, device_id, "temperature", 15.0)  # episode 1 — notifies now
    await evaluate(db_conn, device_id, "temperature", 5.0)  # recovers -> resolved

    # last_notified_at is "just now" — well within the 300s default cooldown.
    second_episode = await evaluate(db_conn, device_id, "temperature", 20.0)

    assert len(second_episode) == 1  # alert row still created, for history
    assert second_episode[0]["pendingWebhook"] is None

    rows = (await db_conn.execute(select(alerts).where(alerts.c.device_id == device_id))).mappings().all()
    assert len(rows) == 2


async def test_evaluate_actuator_dispatch_not_deduped_while_active(db_conn):
    # Actuator dispatch is a continuous control signal, not a notification —
    # unlike Alert rows and notify/webhook, it must keep firing on every
    # breaching reading even while the alert is already active.
    device_id, rule_id = await _seed_device_with_rule(
        db_conn,
        operator="GT",
        threshold=10.0,
        action_type="actuator",
        action_config={"command": "increase_compressor_duty"},
    )

    await evaluate(db_conn, device_id, "temperature", 15.0)
    await evaluate(db_conn, device_id, "temperature", 16.0)

    rows = (
        await db_conn.execute(select(actuator_commands).where(actuator_commands.c.device_id == device_id))
    ).mappings().all()
    assert len(rows) == 2
