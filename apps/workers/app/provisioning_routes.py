"""POST /ingestion/provision — a device's onboarding endpoint (see
app/provisioning_service.py). Deliberately has no auth dependency of its
own: the provisionKey/provisionSecret pair in the body *is* the
authentication, the same way a device's apiKey is on POST
/ingestion/telemetry, not an additional gate on top of one.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.provisioning_service import InvalidProvisioningCredentials, provision_device_self_service

router = APIRouter(prefix="/ingestion", tags=["provisioning"])


class ProvisionRequest(BaseModel):
    provision_key: str
    provision_secret: str
    device_name: str
    location: Optional[str] = None


@router.post("/provision")
async def provision(body: ProvisionRequest) -> dict:
    try:
        return await provision_device_self_service(
            body.provision_key, body.provision_secret, body.device_name, location=body.location
        )
    except InvalidProvisioningCredentials:
        raise HTTPException(status_code=401, detail="Invalid provisioning credentials")
