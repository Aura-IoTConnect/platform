"""Tests for the workers-facing route modules that had no coverage:
app/agents_routes.py, app/actuator_routes.py and app/device_mqtt_routes.py.

Handlers are awaited directly rather than through TestClient, for the same
reason as test_security.py: TestClient runs the app on its own event loop and
the shared asyncpg engine is bound to whichever loop first used it. Where a
handler needs a real device / device type, a fixture seeds committed rows and
removes them afterwards (these handlers open their own transactions, so a
rollback-wrapped connection wouldn't be visible to them)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import actuator_routes, agents_routes, backtest_routes, device_mqtt_routes
from app.agents import AgentsUnavailable
from app.db import (
    actuator_commands,
    device_types,
    devices,
    dispose_engine,
    get_engine,
    new_id,
    rules,
    verticals,
)
from app.mqtt_dynsec import DynsecUnavailable
from app.security import require_workers_token


@pytest.fixture(autouse=True)
async def _dispose_engine_after_each_test():
    # Each test runs on its own event loop but get_engine() caches one pool.
    yield
    await dispose_engine()


@pytest.fixture
async def seeded():
    engine = get_engine()
    vertical_id, device_type_id, device_id, rule_id = new_id(), new_id(), new_id(), new_id()
    now = datetime.now(timezone.utc)
    async with engine.begin() as conn:
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
                metrics=[{"key": "temperature", "label": "Temp", "unit": "C"}],
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
                operator="GT",
                threshold=10.0,
                severity="WARNING",
                action_type="notify",
                action_config=None,
                enabled=True,
                created_at=now,
            )
        )
    try:
        yield {"device_id": device_id, "device_type_id": device_type_id}
    finally:
        async with engine.begin() as conn:
            await conn.execute(actuator_commands.delete().where(actuator_commands.c.device_id == device_id))
            await conn.execute(devices.delete().where(devices.c.id == device_id))
            await conn.execute(rules.delete().where(rules.c.id == rule_id))
            await conn.execute(device_types.delete().where(device_types.c.id == device_type_id))
            await conn.execute(verticals.delete().where(verticals.c.id == vertical_id))


# --- auth boundary ----------------------------------------------------------


@pytest.mark.parametrize(
    "module", [agents_routes, actuator_routes, backtest_routes, device_mqtt_routes], ids=lambda m: m.__name__
)
def test_every_server_to_server_router_requires_the_workers_token(module):
    # These routers are only meant to be called by apps/api (which holds
    # WORKERS_API_TOKEN). Dropping the dependency would silently expose agent
    # runs, actuator dispatch and MQTT credential provisioning to anyone who
    # can reach the port.
    assert any(dep.dependency is require_workers_token for dep in module.router.dependencies)


# --- device_mqtt_routes -----------------------------------------------------


async def test_set_mqtt_credentials_provisions_and_reports_success(monkeypatch):
    calls = []

    async def fake_provision(device_id, password):
        calls.append((device_id, password))

    monkeypatch.setattr(device_mqtt_routes, "provision_device", fake_provision)

    result = await device_mqtt_routes.set_mqtt_credentials(
        "dev-1", device_mqtt_routes.MqttCredentialsRequest(password="pw")
    )

    assert result == {"deviceId": "dev-1", "provisioned": True}
    assert calls == [("dev-1", "pw")]


async def test_set_mqtt_credentials_is_a_503_when_the_broker_is_unavailable(monkeypatch):
    async def fake_provision(device_id, password):
        raise DynsecUnavailable("broker down")

    monkeypatch.setattr(device_mqtt_routes, "provision_device", fake_provision)

    with pytest.raises(HTTPException) as exc:
        await device_mqtt_routes.set_mqtt_credentials("dev-1", device_mqtt_routes.MqttCredentialsRequest(password="pw"))
    assert exc.value.status_code == 503
    assert "broker down" in exc.value.detail


async def test_remove_mqtt_credentials_deprovisions_and_handles_an_unavailable_broker(monkeypatch):
    seen = []

    async def fake_deprovision(device_id):
        seen.append(device_id)

    monkeypatch.setattr(device_mqtt_routes, "deprovision_device", fake_deprovision)
    assert await device_mqtt_routes.remove_mqtt_credentials("dev-1") == {"deviceId": "dev-1", "provisioned": False}
    assert seen == ["dev-1"]

    async def failing_deprovision(device_id):
        raise DynsecUnavailable("broker down")

    monkeypatch.setattr(device_mqtt_routes, "deprovision_device", failing_deprovision)
    with pytest.raises(HTTPException) as exc:
        await device_mqtt_routes.remove_mqtt_credentials("dev-1")
    assert exc.value.status_code == 503


# --- actuator_routes --------------------------------------------------------


async def test_actuator_command_for_an_unknown_device_is_a_404():
    with pytest.raises(HTTPException) as exc:
        await actuator_routes.send_actuator_command(
            "does-not-exist", actuator_routes.ActuatorCommandRequest(command="turn_on")
        )
    assert exc.value.status_code == 404


async def test_actuator_command_is_persisted_as_a_manual_command(seeded):
    result = await actuator_routes.send_actuator_command(
        seeded["device_id"], actuator_routes.ActuatorCommandRequest(command="turn_on_fan", value={"speed": 3})
    )

    assert result["command"] == "turn_on_fan"
    assert result["source"] == "MANUAL"

    async with get_engine().connect() as conn:
        row = (
            await conn.execute(select(actuator_commands).where(actuator_commands.c.device_id == seeded["device_id"]))
        ).mappings().first()
    assert row is not None
    assert row["command"] == "turn_on_fan"
    assert row["source"] == "MANUAL"
    assert row["rule_id"] is None


# --- agents_routes ----------------------------------------------------------


async def test_anomaly_explainer_for_an_unknown_alert_is_a_404():
    with pytest.raises(HTTPException) as exc:
        await agents_routes.run_anomaly_explainer(agents_routes.RunAnomalyExplainerRequest(alert_id="does-not-exist"))
    assert exc.value.status_code == 404


async def test_anomaly_explainer_is_a_503_when_agents_are_not_configured(monkeypatch):
    async def fake_context(conn, alert_id):
        return {"alert": alert_id}

    async def unavailable(*args, **kwargs):
        raise AgentsUnavailable("ANTHROPIC_API_KEY is not set")

    monkeypatch.setattr(agents_routes, "build_anomaly_context", fake_context)
    monkeypatch.setattr(agents_routes, "run_agent", unavailable)

    with pytest.raises(HTTPException) as exc:
        await agents_routes.run_anomaly_explainer(agents_routes.RunAnomalyExplainerRequest(alert_id="a1"))
    assert exc.value.status_code == 503
    assert "ANTHROPIC_API_KEY" in exc.value.detail


async def test_alert_triage_is_a_503_when_agents_are_not_configured(monkeypatch):
    async def unavailable(*args, **kwargs):
        raise AgentsUnavailable("ANTHROPIC_API_KEY is not set")

    monkeypatch.setattr(agents_routes, "run_agent", unavailable)

    with pytest.raises(HTTPException) as exc:
        await agents_routes.run_alert_triage()
    assert exc.value.status_code == 503


async def test_alert_triage_passes_open_alerts_to_the_agent(monkeypatch):
    captured = {}

    async def fake_run_agent(key, context, **kwargs):
        captured["key"] = key
        captured["context"] = context
        return {"ranked": []}

    monkeypatch.setattr(agents_routes, "run_agent", fake_run_agent)

    assert await agents_routes.run_alert_triage() == {"ranked": []}
    assert captured["key"] == "alert-triage"
    assert isinstance(captured["context"]["openAlerts"], list)


async def test_automation_suggester_for_an_unknown_device_type_is_a_404():
    with pytest.raises(HTTPException) as exc:
        await agents_routes.run_automation_suggester(
            agents_routes.RunAutomationSuggesterRequest(device_type_id="does-not-exist")
        )
    assert exc.value.status_code == 404


async def test_automation_suggester_builds_its_context_from_the_types_rules(seeded, monkeypatch):
    captured = {}

    async def fake_run_agent(key, context, **kwargs):
        captured["key"] = key
        captured["context"] = context
        return {"suggestions": []}

    monkeypatch.setattr(agents_routes, "run_agent", fake_run_agent)

    await agents_routes.run_automation_suggester(
        agents_routes.RunAutomationSuggesterRequest(device_type_id=seeded["device_type_id"])
    )

    assert captured["key"] == "automation-suggester"
    context = captured["context"]
    assert context["deviceType"]["name"] == "Test Type"
    assert [r["name"] for r in context["currentRules"]] == ["Test Rule"]
    assert context["currentRules"][0]["operator"] == "GT"
    assert context["recentAlerts"] == []


async def test_automation_suggester_is_a_503_when_agents_are_not_configured(seeded, monkeypatch):
    async def unavailable(*args, **kwargs):
        raise AgentsUnavailable("ANTHROPIC_API_KEY is not set")

    monkeypatch.setattr(agents_routes, "run_agent", unavailable)

    with pytest.raises(HTTPException) as exc:
        await agents_routes.run_automation_suggester(
            agents_routes.RunAutomationSuggesterRequest(device_type_id=seeded["device_type_id"])
        )
    assert exc.value.status_code == 503
