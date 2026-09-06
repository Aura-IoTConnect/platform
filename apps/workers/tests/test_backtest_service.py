"""Integration tests against the real dev Postgres, rolled back per test."""

from datetime import datetime, timedelta, timezone

import pytest

from app.backtest_service import backtest_rule
from app.db import alerts, device_types, devices, dispose_engine, get_engine, new_id, telemetry_readings, verticals
from sqlalchemy import select


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


NOW = datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc)


async def _seed(conn, device_count=1):
    vertical_id, device_type_id = new_id(), new_id()
    await conn.execute(
        verticals.insert().values(id=vertical_id, key=f"t-{vertical_id}", name="V", description="d", created_at=NOW)
    )
    await conn.execute(
        device_types.insert().values(
            id=device_type_id, vertical_id=vertical_id, key="t", name="T", description="d", metrics=[], created_at=NOW
        )
    )
    ids = []
    for i in range(device_count):
        did = new_id()
        await conn.execute(
            devices.insert().values(
                id=did, device_type_id=device_type_id, name=f"D{i}", location=None, status="ONLINE", metadata=None, created_at=NOW
            )
        )
        ids.append(did)
    return device_type_id, ids


async def _readings(conn, device_id, values, metric="temperature", start_minutes_ago=60):
    for i, v in enumerate(values):
        await conn.execute(
            telemetry_readings.insert().values(
                id=new_id(),
                device_id=device_id,
                metric=metric,
                value=v,
                unit=None,
                timestamp=NOW - timedelta(minutes=start_minutes_ago - i),
            )
        )


async def test_counts_breaches_and_episodes(db_conn):
    dt, (d,) = await _seed(db_conn)
    # breach, breach, recover, breach, recover, recover -> 2 episodes, 3 breaching
    await _readings(db_conn, d, [15, 16, 5, 20, 4, 3])

    r = await backtest_rule(db_conn, dt, "temperature", "GT", 10.0, since_hours=24, now=NOW)

    assert r["devicesEvaluated"] == 1
    assert r["readingsEvaluated"] == 6
    assert r["breachingReadings"] == 3
    assert r["estimatedEpisodes"] == 2
    dev = r["byDevice"][0]
    assert dev["episodes"] == 2 and dev["firstBreachAt"] < dev["lastBreachAt"]


async def test_no_readings_is_zero_not_error(db_conn):
    dt, _ = await _seed(db_conn)
    r = await backtest_rule(db_conn, dt, "temperature", "GT", 10.0, now=NOW)
    assert r["readingsEvaluated"] == 0 and r["estimatedEpisodes"] == 0 and r["byDevice"] == []


async def test_scopes_to_device_type_metric_and_window(db_conn):
    dt, (d,) = await _seed(db_conn)
    other_dt, (other,) = await _seed(db_conn)
    await _readings(db_conn, d, [99], metric="humidity")  # wrong metric
    await _readings(db_conn, other, [99])  # wrong device type
    await _readings(db_conn, d, [99], start_minutes_ago=60 * 24 * 30)  # outside 24h window
    await _readings(db_conn, d, [99, 98])  # the only two that count

    r = await backtest_rule(db_conn, dt, "temperature", "GT", 10.0, since_hours=24, now=NOW)
    assert r["readingsEvaluated"] == 2 and r["breachingReadings"] == 2 and r["estimatedEpisodes"] == 1


async def test_episodes_are_per_device(db_conn):
    dt, (a, b) = await _seed(db_conn, device_count=2)
    await _readings(db_conn, a, [15, 15])
    await _readings(db_conn, b, [15, 1, 15])

    r = await backtest_rule(db_conn, dt, "temperature", "GTE", 15.0, now=NOW)
    assert r["devicesEvaluated"] == 2 and r["estimatedEpisodes"] == 3


async def test_writes_nothing(db_conn):
    dt, (d,) = await _seed(db_conn)
    await _readings(db_conn, d, [100])
    await backtest_rule(db_conn, dt, "temperature", "GT", 10.0, now=NOW)
    assert (await db_conn.execute(select(alerts).where(alerts.c.device_id == d))).first() is None


async def test_unknown_operator_raises(db_conn):
    dt, _ = await _seed(db_conn)
    with pytest.raises(ValueError):
        await backtest_rule(db_conn, dt, "temperature", "BETWEEN", 10.0)
