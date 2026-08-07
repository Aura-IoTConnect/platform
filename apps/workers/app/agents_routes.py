"""Endpoints for triggering AI agents. Listing runs and submitting feedback
lives on apps/api (/api/agents/runs, /api/agents/runs/:id/feedback) since
that's plain reads/writes against the same Postgres — no need for Claude
access, so no reason to duplicate it here."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.agents import AgentsUnavailable, build_anomaly_context, run_agent
from app.db import alerts, device_types, get_engine, rules

router = APIRouter(prefix="/agents", tags=["agents"])


class RunAnomalyExplainerRequest(BaseModel):
    alert_id: str


class RunAutomationSuggesterRequest(BaseModel):
    device_type_id: str


@router.post("/anomaly-explainer/run")
async def run_anomaly_explainer(body: RunAnomalyExplainerRequest) -> dict:
    engine = get_engine()
    try:
        async with engine.begin() as conn:
            context = await build_anomaly_context(conn, body.alert_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        return await run_agent("anomaly-explainer", context, alert_id=body.alert_id)
    except AgentsUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/alert-triage/run")
async def run_alert_triage() -> dict:
    engine = get_engine()
    async with engine.begin() as conn:
        open_alerts = (
            await conn.execute(select(alerts).where(alerts.c.status == "OPEN"))
        ).mappings().all()

    context = {
        "openAlerts": [
            {
                "alertId": a["id"],
                "severity": a["severity"],
                "message": a["message"],
                "ageSeconds": (datetime.now(timezone.utc) - a["created_at"]).total_seconds(),
            }
            for a in open_alerts
        ]
    }

    try:
        return await run_agent("alert-triage", context)
    except AgentsUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/automation-suggester/run")
async def run_automation_suggester(body: RunAutomationSuggesterRequest) -> dict:
    engine = get_engine()
    async with engine.begin() as conn:
        device_type = (
            await conn.execute(select(device_types).where(device_types.c.id == body.device_type_id))
        ).mappings().first()
        if device_type is None:
            raise HTTPException(status_code=404, detail="Unknown device_type_id")

        existing_rules = (
            await conn.execute(select(rules).where(rules.c.device_type_id == body.device_type_id))
        ).mappings().all()

        recent_alerts = (
            await conn.execute(
                select(alerts)
                .join(rules, alerts.c.rule_id == rules.c.id)
                .where(rules.c.device_type_id == body.device_type_id)
                .order_by(alerts.c.created_at.desc())
                .limit(20)
            )
        ).mappings().all()

    context = {
        "deviceType": {"name": device_type["name"], "metrics": device_type["metrics"]},
        "currentRules": [
            {
                "name": r["name"],
                "metric": r["metric"],
                "operator": r["operator"],
                "threshold": r["threshold"],
                "severity": r["severity"],
            }
            for r in existing_rules
        ],
        "recentAlerts": [{"severity": a["severity"], "message": a["message"]} for a in recent_alerts],
    }

    try:
        return await run_agent("automation-suggester", context)
    except AgentsUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
