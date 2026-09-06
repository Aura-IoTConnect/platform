"""Unit tests for the pure policy function, plus integration tests for the
on-change persistence check against the real dev Postgres (rolled back per
test, same convention as test_rule_engine.py)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.db import device_types, devices, dispose_engine, get_engine, new_id, telemetry_readings, verticals
from app.metric_pipeline import apply_metric_policy, find_metric_config, should_persist


# --- apply_metric_policy (pure) --------------------------------------------


def test_no_config_passes_value_through():
    assert apply_metric_policy(None, 12.5) == (12.5, True, None)


def test_linear_transform():
    cfg = {"key": "t", "transform": {"type": "linear", "factor": 0.1, "offset": -40}}
    value, accepted, reason = apply_metric_policy(cfg, 650)
    assert accepted and reason is None
    assert value == pytest.approx(25.0)


def test_transform_defaults_when_factor_or_offset_missing():
    cfg = {"key": "t", "transform": {"type": "linear", "offset": 5}}
    assert apply_metric_policy(cfg, 10)[0] == 15


def test_unknown_transform_type_is_ignored():
    cfg = {"key": "t", "transform": {"type": "polynomial", "factor": 99}}
    assert apply_metric_policy(cfg, 10)[0] == 10


def test_out_of_range_pass_is_default():
    cfg = {"key": "t", "min": 0, "max": 100}
    assert apply_metric_policy(cfg, 150) == (150, True, None)


def test_out_of_range_clamp():
    cfg = {"key": "t", "min": 0, "max": 100, "onOutOfRange": "clamp"}
    assert apply_metric_policy(cfg, 150)[0] == 100
    assert apply_metric_policy(cfg, -3)[0] == 0
    assert apply_metric_policy(cfg, 42)[0] == 42


def test_out_of_range_reject():
    cfg = {"key": "t", "min": 0, "max": 100, "onOutOfRange": "reject"}
    value, accepted, reason = apply_metric_policy(cfg, 150)
    assert not accepted and reason == "out_of_range"
    assert apply_metric_policy(cfg, 50) == (50, True, None)


def test_transform_applies_before_range_check():
    # Raw ADC count 1023 -> 100.0 after scaling, which is in range.
    cfg = {
        "key": "t",
        "min": 0,
        "max": 100,
        "onOutOfRange": "reject",
        "transform": {"type": "linear", "factor": 100 / 1023},
    }
    value, accepted, _ = apply_metric_policy(cfg, 1023)
    assert accepted and value == pytest.approx(100.0)


def test_non_finite_is_always_rejected():
    assert apply_metric_policy({"key": "t"}, float("nan"))[1] is False
    assert apply_metric_policy({"key": "t"}, float("inf"))[2] == "non_finite"


def test_find_metric_config_tolerates_bad_shapes():
    assert find_metric_config(None, "t") is None
    assert find_metric_config("not-a-list", "t") is None
    assert find_metric_config([{"key": "other"}, "junk", {"key": "t", "min": 1}], "t") == {"key": "t", "min": 1}


# --- should_persist (integration) -----------------------------------------


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
    vertical_id, device_type_id, device_id = new_id(), new_id(), new_id()
    now = datetime.now(timezone.utc)
    await conn.execute(
        verticals.insert().values(id=vertical_id, key=f"test-{vertical_id}", name="V", description="d", created_at=now)
    )
    await conn.execute(
        device_types.insert().values(
            id=device_type_id, vertical_id=vertical_id, key="t", name="T", description="d", metrics=[], created_at=now
        )
    )
    await conn.execute(
        devices.insert().values(
            id=device_id, device_type_id=device_type_id, name="D", location=None, status="ONLINE", metadata=None, created_at=now
        )
    )
    return device_id


async def _insert_reading(conn, device_id, value, age_seconds=0):
    await conn.execute(
        telemetry_readings.insert().values(
            id=new_id(),
            device_id=device_id,
            metric="temperature",
            value=value,
            unit=None,
            timestamp=datetime.now(timezone.utc) - timedelta(seconds=age_seconds),
        )
    )


async def test_should_persist_always_mode(db_conn):
    device_id = await _seed_device(db_conn)
    await _insert_reading(db_conn, device_id, 10.0)
    assert await should_persist(db_conn, device_id, "temperature", 10.0, {"key": "temperature"}) is True


async def test_should_persist_on_change_first_reading_stored(db_conn):
    device_id = await _seed_device(db_conn)
    cfg = {"key": "temperature", "loggingMode": "on-change", "deadband": 1.0}
    assert await should_persist(db_conn, device_id, "temperature", 10.0, cfg) is True


async def test_should_persist_on_change_skips_within_deadband(db_conn):
    device_id = await _seed_device(db_conn)
    cfg = {"key": "temperature", "loggingMode": "on-change", "deadband": 1.0}
    await _insert_reading(db_conn, device_id, 10.0)
    assert await should_persist(db_conn, device_id, "temperature", 10.5, cfg) is False
    assert await should_persist(db_conn, device_id, "temperature", 11.5, cfg) is True


async def test_should_persist_compares_against_latest_stored_only(db_conn):
    device_id = await _seed_device(db_conn)
    cfg = {"key": "temperature", "loggingMode": "on-change", "deadband": 1.0}
    await _insert_reading(db_conn, device_id, 10.0, age_seconds=60)
    await _insert_reading(db_conn, device_id, 20.0, age_seconds=0)
    # 10.5 is far from the latest (20.0) even though it's near an older row.
    assert await should_persist(db_conn, device_id, "temperature", 10.5, cfg) is True

    rows = (await db_conn.execute(select(telemetry_readings).where(telemetry_readings.c.device_id == device_id))).all()
    assert len(rows) == 2
