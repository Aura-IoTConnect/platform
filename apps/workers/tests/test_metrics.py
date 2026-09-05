"""GET /metrics on apps/workers. Uses FastAPI's TestClient without the
lifespan context, so no dynsec/MQTT bootstrap runs — this only checks the
exposition endpoint and that the ingestion counters are registered."""

from fastapi.testclient import TestClient

from app.main import app
from app.metrics import ingestion_readings_total


def test_metrics_endpoint_exposes_ingestion_counters():
    ingestion_readings_total.labels(transport="http", outcome="accepted").inc(0)

    # Plain TestClient(app).get(...) without the context-manager form — the
    # `with` form is what runs lifespan (dynsec/MQTT bootstrap), not wanted here.
    res = TestClient(app).get("/metrics")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    body = res.text
    assert "# TYPE ingestion_readings_total counter" in body
    assert 'ingestion_readings_total{outcome="accepted",transport="http"}' in body
    assert "rule_evaluation_duration_seconds_bucket" in body
    assert "# TYPE mqtt_bridge_connected gauge" in body
