"""Shared-secret auth for apps/workers' HTTP endpoints (telemetry ingestion,
agent triggers). These aren't user accounts like apps/api's JWT auth —
devices and the dashboard's browser JS call these directly, so a single
shared bearer token (`WORKERS_API_TOKEN`) is the mechanism, not per-user
login.

If `WORKERS_API_TOKEN` is unset, the check is skipped — deliberate for local
dev, matching the existing `ANTHROPIC_API_KEY` convention (best-effort
service, never a hard startup requirement). Left unset, the service is wide
open; see CLAUDE.md.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import Header, HTTPException


async def require_workers_token(authorization: Optional[str] = Header(default=None)) -> None:
    expected = os.environ.get("WORKERS_API_TOKEN")
    if not expected:
        return

    token = authorization[len("Bearer ") :] if authorization and authorization.startswith("Bearer ") else None
    if token != expected:
        raise HTTPException(status_code=401, detail="Missing or invalid bearer token")
