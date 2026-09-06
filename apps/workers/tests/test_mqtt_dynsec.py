"""Integration tests for Mosquitto's dynamic-security plugin (app/mqtt_dynsec.py).

Needs a real broker with dynsec configured (`docker compose up mosquitto`)
and a reachable admin password (MQTT_DYNSEC_ADMIN_PASSWORD, or the bootstrap
.pw file — see .env.example). CI's Postgres-only service doesn't run
Mosquitto, so the provisioning round-trip tests skip themselves rather than
fail when no broker is reachable; the unreachable-broker error path is
asserted unconditionally, since that holds in both environments.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import paho.mqtt.client as mqtt
import pytest

from app.mqtt_dynsec import (
    DynsecUnavailable,
    _admin_credentials,
    deprovision_device,
    ensure_bootstrap,
    provision_device,
)


@pytest.fixture(scope="module")
def dynsec_broker():
    try:
        import asyncio

        asyncio.run(ensure_bootstrap())
    except DynsecUnavailable:
        pytest.skip("no reachable Mosquitto broker with dynamic-security configured")


async def test_ensure_bootstrap_is_idempotent(dynsec_broker):
    # dynsec_broker's fixture setup already ran this once; a second call
    # must skip cleanly rather than fail on "already exists" errors.
    await ensure_bootstrap()


async def test_provision_device_creates_new_client(dynsec_broker):
    device_id = f"pytest-device-{uuid.uuid4().hex}"
    try:
        await provision_device(device_id, "test-password-123")
    finally:
        await deprovision_device(device_id)


async def test_provision_device_rotates_existing_password(dynsec_broker):
    device_id = f"pytest-device-{uuid.uuid4().hex}"
    try:
        await provision_device(device_id, "first-password")
        # Re-provisioning an existing client (rotate-key) must set the new
        # password, not fail on "client already exists".
        await provision_device(device_id, "second-password")
    finally:
        await deprovision_device(device_id)


async def test_deprovision_unknown_device_is_a_noop(dynsec_broker):
    await deprovision_device(f"never-existed-{uuid.uuid4().hex}")


async def test_dynsec_unavailable_when_broker_unreachable(monkeypatch):
    monkeypatch.setenv("MQTT_HOST", "127.0.0.1")
    monkeypatch.setenv("MQTT_PORT", "1")  # nothing listens here
    with pytest.raises(DynsecUnavailable):
        await provision_device("irrelevant", "irrelevant")


def _observe_and_publish(*, admin_username: str, admin_password: str, publisher_username: str, publisher_password: str, own_topic: str, spoofed_topic: str) -> list[str]:
    """Blocking helper (run via asyncio.to_thread): an admin-credentialed
    observer subscribes to telemetry/# (dynsec's admin role bypasses normal
    ACL checks), then `publisher_username` publishes to both `own_topic` and
    `spoofed_topic`. Returns whichever topics the observer actually saw."""
    host = os.environ.get("MQTT_HOST", "localhost")
    port = int(os.environ.get("MQTT_PORT", "1883"))

    received: list[str] = []
    observer = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"pytest-observer-{uuid.uuid4().hex}")
    observer.username_pw_set(admin_username, admin_password)
    observer.on_message = lambda _c, _u, msg: received.append(msg.topic)
    observer.connect(host, port, keepalive=10)
    observer.subscribe("telemetry/#", qos=1)
    observer.loop_start()
    time.sleep(1)

    publisher = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"pytest-publisher-{uuid.uuid4().hex}")
    publisher.username_pw_set(publisher_username, publisher_password)
    publisher.connect(host, port, keepalive=10)
    publisher.loop_start()
    time.sleep(0.5)

    for topic in (own_topic, spoofed_topic):
        publisher.publish(topic, '{"value": 1}', qos=1).wait_for_publish(timeout=3)
    time.sleep(1.5)

    publisher.loop_stop()
    publisher.disconnect()
    observer.loop_stop()
    observer.disconnect()
    return received


async def test_device_publisher_role_is_scoped_to_own_topic(dynsec_broker):
    """Regression test: device-publisher's ACL must be scoped to
    telemetry/<own device_id>/# via dynsec's %u topic substitution — a
    device's credential must not be able to publish (spoof) telemetry under
    another device's id, even though both devices share the same role."""
    device_a = f"pytest-scope-a-{uuid.uuid4().hex}"
    device_b = f"pytest-scope-b-{uuid.uuid4().hex}"
    password = "test-password-123"
    admin_username, admin_password = _admin_credentials()
    try:
        await provision_device(device_a, password)
        await provision_device(device_b, password)

        own_topic = f"telemetry/{device_a}/metric"
        spoofed_topic = f"telemetry/{device_b}/metric"
        received = await asyncio.to_thread(
            _observe_and_publish,
            admin_username=admin_username,
            admin_password=admin_password,
            publisher_username=device_a,
            publisher_password=password,
            own_topic=own_topic,
            spoofed_topic=spoofed_topic,
        )

        assert own_topic in received
        assert spoofed_topic not in received
    finally:
        await deprovision_device(device_a)
        await deprovision_device(device_b)
