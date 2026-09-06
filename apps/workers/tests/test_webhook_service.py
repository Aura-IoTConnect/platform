"""Tests for app/webhook_service.py against a real local HTTP server (no
mocking library) — same "real infra over mocks" convention as the rest of
this test suite (real Postgres, real Mosquitto broker elsewhere)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.webhook_service import dispatch_webhook


class _RecordingHandler(BaseHTTPRequestHandler):
    received: list[dict] = []
    response_status = 200

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler's naming)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        type(self).received.append(json.loads(body))
        self.send_response(type(self).response_status)
        self.end_headers()

    def log_message(self, *args: object) -> None:  # silence stderr noise
        pass


@pytest.fixture
def local_server():
    _RecordingHandler.received = []
    _RecordingHandler.response_status = 200
    server = HTTPServer(("127.0.0.1", 0), _RecordingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", _RecordingHandler
    finally:
        server.shutdown()
        thread.join(timeout=5)


async def test_dispatch_webhook_posts_json_payload(local_server):
    url, handler = local_server
    payload = {"ruleId": "r1", "value": 15.0}

    ok = await dispatch_webhook(url, payload)

    assert ok is True
    assert handler.received == [payload]


async def test_dispatch_webhook_returns_false_on_error_status(local_server):
    url, handler = local_server
    handler.response_status = 500

    ok = await dispatch_webhook(url, {"x": 1})

    assert ok is False


async def test_dispatch_webhook_returns_false_with_no_url():
    ok = await dispatch_webhook(None, {"x": 1})
    assert ok is False


async def test_dispatch_webhook_returns_false_on_unreachable_host():
    # Nothing listens on this port — exercises the connection-error path
    # without depending on external network access in CI.
    ok = await dispatch_webhook("http://127.0.0.1:1/hook", {"x": 1})
    assert ok is False
