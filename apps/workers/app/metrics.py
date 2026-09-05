"""Platform-level observability for apps/workers itself — ingestion
throughput/outcomes, rule-evaluation latency, MQTT bridge connection state —
as opposed to Alert/TelemetryReading, which model the industrial process
being monitored. Exposed in Prometheus text format at GET /metrics (mounted
in main.py). Nothing scrapes it yet; see CLAUDE.md.

Label sets are deliberately tiny and fixed. A Prometheus series exists per
unique label combination, so device/rule/alert ids must never be labels —
per-device detail belongs in telemetry_readings rows, not here.
"""

from __future__ import annotations

from fastapi import Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

ingestion_readings_total = Counter(
    "ingestion_readings_total",
    "Telemetry readings received by apps/workers, by transport and outcome",
    ["transport", "outcome"],  # transport: http|mqtt; outcome: accepted|rejected|unknown_device
)

rule_evaluation_duration_seconds = Histogram(
    "rule_evaluation_duration_seconds",
    "Time spent evaluating rules for one ingested reading",
    buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1),
)

alerts_created_total = Counter(
    "alerts_created_total",
    "Alerts created by the rule engine, by severity",
    ["severity"],
)

mqtt_bridge_connected = Gauge(
    "mqtt_bridge_connected",
    "1 while apps/workers' MQTT bridge is connected to the broker, else 0",
)

def metrics_endpoint() -> Response:
    """Plain in-process registry: apps/workers runs as a single uvicorn
    process (see CLAUDE.md's Commands); the multiprocess collector variant
    only matters if it's ever run with multiple worker processes. An explicit
    route rather than prometheus_client's make_asgi_app() mount, because a
    Starlette mount 307-redirects the bare `/metrics` path to `/metrics/`
    and Prometheus scrapes exactly `/metrics`."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
