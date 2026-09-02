"""Async DB access for apps/workers.

Schema is owned by apps/api (Prisma) — see apps/api/prisma/schema.prisma and
CLAUDE.md. This module only mirrors the resulting Postgres tables with plain
SQLAlchemy Core `Table` objects (snake_case, matching Prisma's `@@map`/`@map`
directives) so workers can read/write telemetry and alerts. Never run
migrations from here.
"""

from __future__ import annotations

import os
import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    MetaData,
    String,
    Table,
)
from sqlalchemy.dialects.postgresql import ENUM, JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

metadata = MetaData()

# Prisma creates these Postgres enum types (see schema.prisma @@map names);
# create_type=False so SQLAlchemy never tries to (re)create them — Prisma
# migrations own that.
device_status_enum = ENUM("ONLINE", "OFFLINE", "MAINTENANCE", name="device_status", create_type=False, metadata=metadata)
rule_operator_enum = ENUM("GT", "GTE", "LT", "LTE", "EQ", name="rule_operator", create_type=False, metadata=metadata)
alert_severity_enum = ENUM("INFO", "WARNING", "CRITICAL", name="alert_severity", create_type=False, metadata=metadata)
alert_status_enum = ENUM("OPEN", "ACKNOWLEDGED", "RESOLVED", name="alert_status", create_type=False, metadata=metadata)
agent_run_status_enum = ENUM(
    "PENDING", "COMPLETED", "FAILED", name="agent_run_status", create_type=False, metadata=metadata
)
actuator_command_source_enum = ENUM(
    "RULE", "MANUAL", name="actuator_command_source", create_type=False, metadata=metadata
)


def new_id() -> str:
    """Prisma generates cuid()s client-side; workers use uuid4 instead — both
    are opaque text ids, so any unique string works for these tables."""
    return uuid.uuid4().hex


devices = Table(
    "devices",
    metadata,
    Column("id", String, primary_key=True),
    Column("device_type_id", String, ForeignKey("device_types.id")),
    Column("name", String),
    Column("location", String),
    Column("status", device_status_enum),
    Column("metadata", JSONB),
    Column("api_key_hash", String),
    Column("created_at", DateTime(timezone=True)),
)

device_types = Table(
    "device_types",
    metadata,
    Column("id", String, primary_key=True),
    Column("vertical_id", String, ForeignKey("verticals.id")),
    Column("key", String),
    Column("name", String),
    Column("description", String),
    Column("metrics", JSONB),
    Column("created_at", DateTime(timezone=True)),
)

verticals = Table(
    "verticals",
    metadata,
    Column("id", String, primary_key=True),
    Column("key", String),
    Column("name", String),
    Column("description", String),
    Column("created_at", DateTime(timezone=True)),
)

telemetry_readings = Table(
    "telemetry_readings",
    metadata,
    Column("id", String, primary_key=True),
    Column("device_id", String, ForeignKey("devices.id")),
    Column("metric", String),
    Column("value", Float),
    Column("unit", String),
    Column("timestamp", DateTime(timezone=True)),
)

rules = Table(
    "rules",
    metadata,
    Column("id", String, primary_key=True),
    Column("device_type_id", String, ForeignKey("device_types.id")),
    Column("name", String),
    Column("metric", String),
    Column("operator", rule_operator_enum),
    Column("threshold", Float),
    Column("severity", alert_severity_enum),
    Column("action_type", String),
    Column("action_config", JSONB),
    Column("enabled", Boolean),
    Column("created_at", DateTime(timezone=True)),
)

alerts = Table(
    "alerts",
    metadata,
    Column("id", String, primary_key=True),
    Column("device_id", String, ForeignKey("devices.id")),
    Column("rule_id", String, ForeignKey("rules.id")),
    Column("severity", alert_severity_enum),
    Column("message", String),
    Column("status", alert_status_enum),
    Column("created_at", DateTime(timezone=True)),
    Column("resolved_at", DateTime(timezone=True)),
)

agents = Table(
    "agents",
    metadata,
    Column("id", String, primary_key=True),
    Column("key", String),
    Column("name", String),
    Column("description", String),
    Column("system_prompt", String),
    Column("created_at", DateTime(timezone=True)),
)

agent_runs = Table(
    "agent_runs",
    metadata,
    Column("id", String, primary_key=True),
    Column("agent_id", String, ForeignKey("agents.id")),
    Column("alert_id", String, ForeignKey("alerts.id")),
    Column("input", JSONB),
    Column("output", JSONB),
    Column("status", agent_run_status_enum),
    Column("created_at", DateTime(timezone=True)),
    Column("completed_at", DateTime(timezone=True)),
)

actuator_commands = Table(
    "actuator_commands",
    metadata,
    Column("id", String, primary_key=True),
    Column("device_id", String, ForeignKey("devices.id")),
    Column("rule_id", String, ForeignKey("rules.id")),
    Column("command", String),
    Column("value", JSONB),
    Column("source", actuator_command_source_enum),
    Column("created_at", DateTime(timezone=True)),
)


def _asyncpg_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        database_url = os.environ.get(
            "DATABASE_URL", "postgresql://iotplatform:iotplatform@localhost:5432/iotplatform"
        )
        _engine = create_async_engine(_asyncpg_url(database_url), pool_pre_ping=True)
    return _engine


async def dispose_engine() -> None:
    """asyncpg connections are bound to the event loop they were created on.
    pytest-asyncio gives each test function a fresh loop by default, so tests
    must dispose the (module-singleton) engine between tests — otherwise the
    second test to touch it reuses pooled connections from a dead loop."""
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None
