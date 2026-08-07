"""Real Anthropic-backed AI agents.

Each agent is a row in the `agents` table (key, name, systemPrompt) seeded by
apps/api/prisma/seed.ts. Running one here: builds a context-specific input,
calls Claude, persists the raw input/output as an AgentRun, and — via
AgentFeedback (written by apps/api) — closes the loop on whether the agent's
suggestions were actually good.

Requires ANTHROPIC_API_KEY. If it isn't set, agents are unavailable and every
entry point here raises AgentsUnavailable rather than fabricating a key or
silently no-op'ing.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import agent_runs, agents, alerts, device_types, devices, get_engine, new_id, rules, telemetry_readings, verticals

logger = logging.getLogger("agents")

DEFAULT_MODEL = os.environ.get("CLAUDE_AGENT_MODEL", "claude-sonnet-4-5")


class AgentsUnavailable(RuntimeError):
    pass


def _require_api_key() -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise AgentsUnavailable(
            "ANTHROPIC_API_KEY is not set. Add it to apps/workers/.env to enable AI agents."
        )
    return api_key


async def _get_client():
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(api_key=_require_api_key())


async def _load_agent(conn, key: str) -> dict:
    row = (await conn.execute(select(agents).where(agents.c.key == key))).mappings().first()
    if row is None:
        raise ValueError(f"Unknown agent key: {key}")
    return dict(row)


async def _create_run(conn, agent_id: str, alert_id: str | None, input_payload: dict) -> str:
    run_id = new_id()
    await conn.execute(
        agent_runs.insert().values(
            id=run_id,
            agent_id=agent_id,
            alert_id=alert_id,
            input=input_payload,
            output=None,
            status="PENDING",
            created_at=datetime.now(timezone.utc),
            completed_at=None,
        )
    )
    return run_id


async def _complete_run(conn, run_id: str, output: dict) -> None:
    await conn.execute(
        agent_runs.update()
        .where(agent_runs.c.id == run_id)
        .values(output=output, status="COMPLETED", completed_at=datetime.now(timezone.utc))
    )


async def _fail_run(conn, run_id: str, error: str) -> None:
    await conn.execute(
        agent_runs.update()
        .where(agent_runs.c.id == run_id)
        .values(output={"error": error}, status="FAILED", completed_at=datetime.now(timezone.utc))
    )


async def _call_claude(system_prompt: str, input_payload: dict) -> dict:
    client = await _get_client()
    message = await client.messages.create(
        model=DEFAULT_MODEL,
        max_tokens=1024,
        system=system_prompt,
        messages=[{"role": "user", "content": json.dumps(input_payload)}],
    )
    text = "".join(block.text for block in message.content if block.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


async def run_agent(key: str, input_payload: dict, alert_id: str | None = None) -> dict:
    """Runs the named agent against `input_payload`, persisting an AgentRun.
    Raises AgentsUnavailable if ANTHROPIC_API_KEY is unset (checked before
    any DB writes, so no PENDING run is left dangling)."""

    _require_api_key()

    engine = get_engine()
    async with engine.begin() as conn:
        agent = await _load_agent(conn, key)
        run_id = await _create_run(conn, agent["id"], alert_id, input_payload)

    try:
        output = await _call_claude(agent["system_prompt"], input_payload)
    except Exception as exc:  # noqa: BLE001 - persist any failure onto the run
        logger.exception("agent run failed key=%s run_id=%s", key, run_id)
        async with engine.begin() as conn:
            await _fail_run(conn, run_id, str(exc))
        return {"id": run_id, "status": "FAILED", "error": str(exc)}

    async with engine.begin() as conn:
        await _complete_run(conn, run_id, output)

    return {"id": run_id, "status": "COMPLETED", "output": output}


async def build_anomaly_context(conn, alert_id: str) -> dict:
    alert = (await conn.execute(select(alerts).where(alerts.c.id == alert_id))).mappings().first()
    if alert is None:
        raise ValueError(f"Unknown alert id: {alert_id}")

    device = (await conn.execute(select(devices).where(devices.c.id == alert["device_id"]))).mappings().first()
    device_type = (
        await conn.execute(select(device_types).where(device_types.c.id == device["device_type_id"]))
    ).mappings().first()
    vertical = (
        await conn.execute(select(verticals).where(verticals.c.id == device_type["vertical_id"]))
    ).mappings().first()
    rule = None
    if alert["rule_id"]:
        rule = (await conn.execute(select(rules).where(rules.c.id == alert["rule_id"]))).mappings().first()

    recent = (
        await conn.execute(
            select(telemetry_readings)
            .where(telemetry_readings.c.device_id == alert["device_id"])
            .order_by(telemetry_readings.c.timestamp.desc())
            .limit(10)
        )
    ).mappings().all()

    return {
        "alert": {"id": alert["id"], "severity": alert["severity"], "message": alert["message"]},
        "device": {"id": device["id"], "name": device["name"], "location": device["location"]},
        "deviceType": {"name": device_type["name"], "metrics": device_type["metrics"]},
        "vertical": {"name": vertical["name"]},
        "rule": {"name": rule["name"], "metric": rule["metric"], "operator": rule["operator"], "threshold": rule["threshold"]}
        if rule
        else None,
        "recentReadings": [
            {"metric": r["metric"], "value": r["value"], "timestamp": r["timestamp"].isoformat()} for r in recent
        ],
    }


async def maybe_trigger_anomaly_explainer(alert_id: str) -> None:
    """Auto-run the anomaly-explainer agent on a freshly created CRITICAL
    alert. Best-effort: logs and returns if agents aren't configured rather
    than failing telemetry ingestion."""

    try:
        _require_api_key()
    except AgentsUnavailable:
        logger.info("ANTHROPIC_API_KEY not set; skipping auto anomaly-explainer for alert=%s", alert_id)
        return

    engine = get_engine()
    async with engine.begin() as conn:
        context = await build_anomaly_context(conn, alert_id)

    await run_agent("anomaly-explainer", context, alert_id=alert_id)
