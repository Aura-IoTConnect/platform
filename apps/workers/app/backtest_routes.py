"""POST /rules/backtest — read-only, proxied from apps/api's
POST /api/rules/backtest (same server-to-server boundary as agent triggers
and actuator commands, see CLAUDE.md). Writes nothing."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.backtest_service import backtest_rule
from app.db import get_engine
from app.security import require_workers_token

router = APIRouter(prefix="/rules", tags=["rules"], dependencies=[Depends(require_workers_token)])


class BacktestRequest(BaseModel):
    device_type_id: str
    metric: str
    operator: str
    threshold: float
    since_hours: int = Field(default=168, ge=1, le=24 * 365)


@router.post("/backtest")
async def backtest(body: BacktestRequest) -> dict:
    engine = get_engine()
    async with engine.connect() as conn:  # read-only; no transaction needed
        try:
            return await backtest_rule(
                conn, body.device_type_id, body.metric, body.operator, body.threshold, since_hours=body.since_hours
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
