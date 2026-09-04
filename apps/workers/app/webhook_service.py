"""Real dispatch for Rule's `actionType: "webhook"` (previously just logged
via `logger.info`, never actually called — see rule_engine.py).

Best-effort, same convention as every other external dependency in this
project (ANTHROPIC_API_KEY, WORKERS_API_TOKEN): a slow or failing webhook
must never block the control loop, so failures are logged and swallowed,
never raised.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger("webhook")

WEBHOOK_TIMEOUT_S = 5.0


async def dispatch_webhook(url: Optional[str], payload: dict[str, Any]) -> bool:
    if not url:
        logger.warning("webhook actionType configured with no url in actionConfig — skipping")
        return False

    try:
        async with httpx.AsyncClient(timeout=WEBHOOK_TIMEOUT_S) as client:
            response = await client.post(url, json=payload)
        if response.status_code >= 400:
            logger.warning("webhook call to %s returned status=%s", url, response.status_code)
            return False
        return True
    except httpx.HTTPError as exc:
        logger.warning("webhook call to %s failed: %s", url, exc)
        return False
