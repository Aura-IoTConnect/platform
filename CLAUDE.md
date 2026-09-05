# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

A generic, config-driven IoT/SCADA/AI-agent platform. Verticals (cold storage,
mining, smart city, ...) are **not** separate codebases — they're seed data
against one schema, so the same pipeline (telemetry → rules → alerts →
agents) works across every industry.

- `apps/api` — Node.js/Express + TypeScript. Owns the schema (Prisma,
  `apps/api/prisma/schema.prisma`) and all REST reads/writes for verticals,
  device types, devices, rules, alerts, and agent runs/feedback. Protected by
  JWT auth (`src/auth.ts`) — see Auth below.
- `apps/web` — React + Vite + TypeScript dashboard with three tabs: Devices,
  Alerts, Agent Runs (`apps/web/src/{Devices,Alerts,AgentRuns}Tab.tsx`), behind
  a login screen (`src/Login.tsx`, `src/auth.tsx`).
- `apps/workers` — Python/FastAPI. Owns telemetry ingestion (HTTP + MQTT), the
  rule (control-loop) engine, and AI agent execution — decoupled from the Node
  API so protocol/data workloads (MQTT, LLM calls) don't block the request/
  response API. Not behind apps/api's JWT auth (see Auth below).
- `infra/mosquitto.conf` — local MQTT broker config used by `docker-compose.yml`.

### Data model (generic engine)

`Vertical` → `DeviceType` (carries a JSON `metrics` taxonomy: key/label/unit/
range) → `Device` → `TelemetryReading`. `Rule` (metric + operator + threshold
+ severity + actionType) is scoped to a `DeviceType`, so one rule set applies
to every device of that type. A rule breach creates an `Alert` and, on
CRITICAL severity, auto-triggers the `anomaly-explainer` AI agent. On an
`actionType: "actuator"` rule, it also writes an `ActuatorCommand`
(`source: RULE`) — see Actuator control below. `AgentRun` records are
optionally scored via `AgentFeedback` (thumbs up/down in the Agent Runs
tab) — that's the feedback loop on agent quality over time. `User` is
separate from all of this — it's dashboard/API auth, not part of the
device/telemetry model.

Seeded verticals (`apps/api/prisma/seed.ts`): agri-processing, weather,
cold-storage, smart-home-office, warehousing, e-health, smart-metering,
manufacturing, water-treatment, mining, security, transportation, smart-city,
energy (solar). Adding a vertical means adding seed data (device types +
metrics + rules), not new code.

### Schema ownership — read before touching either service's DB code

**Prisma (`apps/api/prisma/schema.prisma`) is the single schema owner.**
Migrations only ever run from `apps/api` (`npm run db:migrate`).
`apps/workers/app/db.py` mirrors the same Postgres tables with plain
SQLAlchemy Core `Table` objects (snake_case, matching Prisma's `@@map`/`@map`
directives, including the native Postgres enum types) — it only reads and
writes rows, it never creates or alters tables. If you change `schema.prisma`,
update `db.py`'s mirrored `Table`/`ENUM` defs to match.

### Auth

`apps/api` requires a bearer JWT on every `/api/*` route except
`POST /api/auth/login` (`src/auth.ts` `requireAuth` middleware, mounted in
`src/app.ts`). Users are seeded via `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars at
`npm run db:seed` time (skipped if unset). The dashboard (`apps/web`) stores
the token in `localStorage` and logs out automatically on any `401`
(`src/api.ts`'s `auth:unauthorized` event).

`apps/workers` is **not** behind this auth directly — its HTTP endpoints
(`/ingestion/*`, `/agents/*`) don't know about user accounts. Two different
callers reach them by two different paths:

- **The dashboard** never calls `apps/workers` directly. Agent triggers go
  through `apps/api`'s `POST /api/agents/{key}/run` (`src/routes/agents.ts`),
  which sits behind the normal JWT `requireAuth` middleware and then forwards
  server-side to `apps/workers` via `src/workersClient.ts`, attaching
  `WORKERS_API_TOKEN` from `apps/api`'s own env. That token never reaches the
  browser.
- **Devices/simulators** (no user accounts) call `POST /ingestion/telemetry`
  on `apps/workers` directly, over MQTT or HTTP. The HTTP path is per-device:
  `apps/api` generates a random key when a device is created
  (`POST /api/devices`, `src/apiKeys.ts`) and returns it exactly once in the
  response (`apiKey` field) — only its SHA-256 hash is stored
  (`Device.apiKeyHash`). `POST /api/devices/:id/rotate-key` issues a new one.
  `apps/workers/app/security.py`'s `check_device_auth` re-derives that same
  hash from the request's bearer token and compares it against the specific
  `device_id` in the payload. A device with no key configured (e.g. seeded
  demo devices, which never got one) falls back to the single shared
  `WORKERS_API_TOKEN` instead; if that's also unset, ingestion for that
  device is open (dev default, same convention as `ANTHROPIC_API_KEY`).
  MQTT ingestion is gated separately, at the broker, with per-device
  credentials matching the HTTP path — see Per-device MQTT auth below.

Don't assume a request reaching `apps/workers` was authenticated as a
specific user — at most it proves possession of a device's key or the one
shared token.

### Per-device MQTT auth

Mosquitto's **dynamic-security plugin** (`mosquitto_dynamic_security.so`,
bundled in the `eclipse-mosquitto:2` image, configured via
`infra/mosquitto.conf`) replaces the old single-shared-credential setup —
each device gets its own MQTT user (`username = device_id`), reusing the
same raw key `apps/api` already generates for HTTP ingestion
(`Device.apiKeyHash`), so rotating a device's key rotates both at once.

- **Provisioning** (`apps/workers/app/mqtt_dynsec.py`) speaks the plugin's
  JSON control-topic protocol directly over MQTT (publish a command to
  `$CONTROL/dynamic-security/v1`, read the correlated response off
  `$CONTROL/dynamic-security/v1/response`) via paho-mqtt, rather than
  shelling out to the `mosquitto_ctrl` CLI — no dependency on the CLI or
  Docker being available wherever `apps/workers` actually runs.
- **Roles**: `device-publisher` (publish-only, and — via dynsec's `%u`
  topic-substitution — scoped to `telemetry/<own username>/#`, so a device's
  credential can publish its own telemetry but can't spoof another device's;
  a device never needs to subscribe). `shared-publisher` (publish-only,
  unscoped `telemetry/#`) and `telemetry-subscriber` (subscribe-only,
  unscoped `telemetry/#`, used by `apps/workers`' own MQTT bridge,
  `mqtt_client.py`, to actually consume messages) both exist only for the
  shared fallback credential (`MQTT_USERNAME`/`MQTT_PASSWORD`) — it
  legitimately publishes on behalf of many device_ids (unprovisioned/demo
  devices, `scripts/simulate_fleet.py`), so it can't be scoped like a
  per-device client and gets its own separate role instead of
  `device-publisher`.
- **Bootstrap** (`ensure_bootstrap()`, called once at `apps/workers` startup,
  `main.py`'s lifespan) creates those two roles, provisions the shared
  fallback credential into dynsec, and deletes the plugin's auto-created
  `democlient` demo account. Idempotent by checking state first
  (`getRole`/`getClient`) rather than tolerating "already exists" errors
  after the fact — some dynsec errors are a generic `"Internal error"`,
  too fragile to string-match safely.
- **Per-device provisioning**: `apps/api`'s device routes
  (`src/routes/devices.ts`) call `apps/workers`' `POST
  /devices/{id}/mqtt-credentials` (`app/device_mqtt_routes.py`, behind
  `require_workers_token` like other workers-facing endpoints — see Auth
  above) on device create and on `rotate-key`, passing the same raw
  `apiKey`. Best-effort: a failure (workers or the broker down) doesn't
  block device creation/rotation, which still work over HTTP — the response
  carries a `mqttProvisioned` boolean for the caller to know whether the
  MQTT credential is actually in sync.
- **Bootstrap admin credentials**: the plugin self-generates an `admin` user
  with a random password on first boot, written to
  `infra/mosquitto-dynsec-state/dynamic-security.json.pw` (bind-mounted, so
  `apps/workers` — running natively on the host, not in Docker — can read it
  directly). `MQTT_DYNSEC_ADMIN_PASSWORD` overrides this for deployments
  where that file isn't reachable.
- Not implemented: deprovisioning on device delete (`deprovision_device()`
  exists and is called from `DELETE /devices/{id}/mqtt-credentials`, but no
  `apps/api` device-delete route calls it yet — soft-delete support lives on
  a sibling branch/PR).

### Self-service device provisioning

Until now, onboarding a device meant an operator creating its `Device` row
first (`POST /api/devices`) and handing the returned `apiKey` to the device
out of band. `POST /ingestion/provision` (`apps/workers/app/provisioning_routes.py`
+ `provisioning_service.py`) is a second path: a device creates its own
`Device` row by presenting a `DeviceType`-level provisioning credential
instead — the ThingsBoard "allow-create-new" provisioning strategy, in
miniature (mining ThingsBoard for ideas worth porting, not its code).

- **`DeviceType.provisionKey`/`provisionSecretHash`**: a public-ish lookup
  identifier + the SHA-256 hash of a secret, generated via
  `POST /api/device-types/:id/provisioning-secret` (JWT-protected, same
  one-time-reveal / rotate-invalidates-the-old-pair UX as
  `POST /api/devices/:id/rotate-key`). Both null until an operator
  generates one — provisioning is opt-in per device type. `provisionKey`
  isn't itself secret (think client ID, meant to be embedded in firmware)
  so it's included in normal `DeviceType` responses; `provisionSecretHash`
  never is, from either `deviceTypes.ts`'s own routes or the same field
  nested inside a `Device` response's `deviceType` (`devices.ts` needed its
  own, separate omission for that nested copy — a real leak, caught in this
  session, is exactly why both call sites need it).
- **`POST /ingestion/provision`** (no auth dependency of its own — the
  `provisionKey`/`provisionSecret` pair in the body *is* the authentication,
  same relationship `apiKey` has to `POST /ingestion/telemetry`): looks up
  the `DeviceType` by `provisionKey`, verifies the secret's hash, creates
  the `Device` row, generates a raw `apiKey` the same way `apps/api` does
  (`apps/workers/app/provisioning_service.py`'s `_generate_key`/`_hash_key`
  mirror `apps/api/src/apiKeys.ts` exactly), and best-effort provisions its
  MQTT credential the same way `POST /api/devices` does. Returns
  `{deviceId, apiKey, mqttProvisioned}` — a self-provisioned device is
  indistinguishable from an operator-created one afterward.
- This is the one place `apps/workers` **creates** a `Device` row rather
  than only reading/updating one — still consistent with the schema-
  ownership rule above (that rule is about DDL/migrations, not row-level
  writes; workers already inserts into `alerts`/`actuator_commands`/etc.).
- The dashboard's Devices tab has a "Generate/Rotate provisioning key"
  button next to the device-type picker (`DevicesTab.tsx`) that calls the
  `apps/api` endpoint and shows the one-time credential — mirroring the
  existing device-apiKey reveal banner.

### Ingest-time metric pipeline (`apps/workers/app/metric_pipeline.py`)

One pre-processing step sits between a raw reading arriving and the
persist → evaluate-rules control loop below, configured per metric entry in
`DeviceType.metrics` (no schema migration — `metrics` is already JSON):

- `transform: {type: "linear", factor, offset}` — `value*factor + offset`,
  for sensors that report raw counts or the wrong unit (rules assume the
  metric's declared unit).
- `onOutOfRange: "pass" | "clamp" | "reject"` — checked against the entry's
  `min`/`max` *after* the transform; default `pass` is the pre-existing
  behavior. `reject` means the reading is neither persisted nor
  rule-evaluated (HTTP ingestion returns `422`, MQTT logs a warning).
  Non-finite values (NaN/inf) are always rejected regardless.
- `loggingMode: "on-change"` + `deadband` — skips the `TelemetryReading`
  insert when the value hasn't moved past `deadband` since the last
  *stored* reading for that (device, metric). This thins history only:
  `evaluate()` still runs on every reading, so alerting is unaffected.

Concept mined from Telegraf/NiFi/Node-RED's staged transform pipelines and
RapidSCADA/ScadaBR's per-point logging modes, deliberately reduced to a
fixed set of `type`-dispatched built-ins (the same convention
`defaultWidgets` uses) — not a plugin loader or arbitrary-code stage. The
seeded `grain-dryer` type's `grain_moisture` metric is the working example.

### Platform observability (`GET /metrics` on both services)

A different axis from `Alert`/`TelemetryReading`, which model the
*industrial process* being monitored: these metrics are about the health
of `apps/api` and `apps/workers` themselves. Both expose Prometheus text
format — `apps/api/src/metrics.ts` (prom-client: default Node process
metrics + `http_requests_total` / `http_request_duration_seconds` labeled
by method / matched route template / status) and
`apps/workers/app/metrics.py` (prometheus_client:
`ingestion_readings_total{transport,outcome}`,
`rule_evaluation_duration_seconds`, `alerts_created_total{severity}`,
`mqtt_bridge_connected` 0/1). Both `/metrics` routes are deliberately
outside the JWT / workers-token gates, same carve-out as `/health` — a
scraper carries no user token, and it's ops data, not device/user data.

Label sets are tiny and fixed on purpose: a Prometheus series exists per
unique label combination, so device/rule/alert/user ids must never become
labels. Nothing scrapes these yet — a Prometheus server + Grafana in
`docker-compose.yml` is the obvious next step once there's an operational
reason for it, not before (mined from Prometheus/Grafana's pull model;
endpoints first, infra later).

### Rule backtest (dry-run before enabling)

`POST /api/rules/backtest` (`src/routes/rules.ts`, JWT-protected) proxies
to `apps/workers`' `POST /rules/backtest` (`app/backtest_routes.py` +
`backtest_service.py`, behind `require_workers_token` — same boundary as
agent triggers) with `{deviceTypeId, metric, operator, threshold,
sinceHours?}`. It replays that candidate condition over the stored
`TelemetryReading` rows of every device of that type in the window, using
`rule_engine.OPERATORS` verbatim, and reports `breachingReadings` plus an
`estimatedEpisodes` count that mirrors the live alert lifecycle per device
(a breach opens an episode, it closes on the first non-breaching reading).
Read-only: no `Alert`/`ActuatorCommand` rows, no notify/webhook dispatch,
no cooldown consumed. The device detail view lists the type's rules with a
"Backtest 7d" button each (`DeviceDetail.tsx`). Mined from the
validate-before-deploy idea behind OpenModelica/OMSimulator co-simulation,
scaled to one flat condition row replayed over stored data.

### The two loops

1. **Control loop** (SCADA-style, `apps/workers/app/rule_engine.py`, entered
   via `app/telemetry_service.py::ingest_reading`): sense (telemetry ingested,
   HTTP or MQTT) → analyze (rules for that device's type + metric) → decide
   (threshold breached?) → act (create `Alert`, dispatch `notify` (logged) /
   `webhook` (logged, no real HTTP call) / `actuator` (persisted — see
   below)) → next reading.
2. **Agent feedback loop**: an `AgentRun`'s output can be scored via
   `AgentFeedback` (`POST /api/agents/runs/:id/feedback`), so agent quality
   is trackable over time instead of being a one-shot, unverified suggestion.

### Actuator control

There's no real hardware behind this — `ActuatorCommand` is the audit trail
/ dispatch record a real actuator integration would write to, not a live
device link. Two sources write it, both through
`apps/workers/app/actuator_service.py::dispatch_command`:

- **`source: RULE`** — `rule_engine.py`, on an `actionType: "actuator"` rule
  breach, in the same transaction as the `Alert` it's paired with.
- **`source: MANUAL`** — a dashboard user, via the "Send command" form in a
  device's detail view. The browser calls `apps/api`'s
  `POST /api/devices/:id/actuator` (JWT-protected), which proxies
  server-side to `apps/workers`' `POST /devices/{id}/actuator`
  (`app/actuator_routes.py`) the same way agent triggers do — see Auth
  above. `GET /api/actuator-commands?deviceId=` (`apps/api`) reads the
  history straight from Postgres, no workers round-trip needed.

`callWorkers` (`apps/api/src/workersClient.ts`) catches network-level
failures (workers unreachable) and returns a normal `502`, not a rejected
promise — Express 4 doesn't catch async route errors, so this used to be
able to crash the whole `apps/api` process if workers was down when a proxy
route fired.

### Telemetry ingestion transports

Both paths call the same `app/telemetry_service.py::ingest_reading`, so the
control loop only has one implementation:

- HTTP: `POST /ingestion/telemetry` (`apps/workers/app/ingestion.py`).
- MQTT: topic `telemetry/<device_id>/<metric>`, JSON payload
  `{"value": <float>, "unit": <str, optional>}` (`apps/workers/app/mqtt_client.py`).
  paho-mqtt callbacks run on a background thread, not the asyncio loop —
  messages are handed off via `asyncio.run_coroutine_threadsafe`. If the
  broker is unreachable at startup, MQTT ingestion is disabled (logged
  warning) and HTTP ingestion keeps working.

`apps/workers/scripts/simulate_fleet.py` publishes plausible telemetry over
MQTT for every seeded device on a timer (`python -m scripts.simulate_fleet
--interval 5`), using each device type's metric min/max — useful for seeing
the dashboard/rules/agents react without real hardware.

### AI agents (`apps/workers/app/agents.py`)

Real Anthropic API calls — **requires `ANTHROPIC_API_KEY`** in
`apps/workers/.env`. Without it, agent endpoints return `503` and telemetry
ingestion / the control loop keep working normally (agents are best-effort,
never a hard dependency of ingestion).

- `anomaly-explainer` — auto-triggered on CRITICAL alerts; also has a manual
  "Explain" button per alert in the Alerts tab. Explains likely root cause
  from the breached rule + recent readings.
- `alert-triage` — "Triage open alerts" button in the Alerts tab; ranks
  currently open alerts by true operational urgency.
- `automation-suggester` — "Suggest automation" button in a device's detail
  view (Devices tab); given a device type's rules + recent alert history,
  proposes new/adjusted rules.

The actual Claude calls live on `apps/workers` (`POST /agents/{key}/run`
variants, see `agents_routes.py`), but the dashboard triggers them through
`apps/api`'s `POST /api/agents/{key}/run`, which proxies server-side — see
Auth above. Listing runs and submitting feedback also lives on `apps/api`
(`GET /api/agents/runs`, `POST /api/agents/runs/:id/feedback`) since that's a
plain DB read/write, no Claude access needed.

### Dashboard widgets (`apps/web/src/widgets/`)

A `DeviceType` can declare `defaultWidgets: Json` — an array of
`{type, metricKey?, label?}` (`type` is `"line-chart" | "gauge" |
"stat-tile" | "alarm-table"`; `metricKey` is required for all but
`alarm-table`, which is bound to the device itself). `DeviceDetail.tsx`
renders that config via `WidgetRenderer.tsx` instead of its original
one-line-chart-per-metric loop, which is still the fallback for any device
type that leaves `defaultWidgets` null/empty (mining ThingsBoard's
dashboard/widget model for the idea worth porting — a widget's data source
resolved declaratively rather than hardcoded — not its code or its full
drag-and-drop dashboard editor, which is disproportionate at this
platform's scale; see earlier conversation).

Each widget type is its own small component (`LineChartWidget`,
`GaugeWidget`, `StatTile`, `AlarmTableWidget`) — no charting library, same
zero-dependency inline-SVG convention as the existing `LineChart.tsx`
(`GaugeWidget` is an SVG radial progress ring, not an external gauge
component). `AlarmTableWidget` fetches its own data
(`GET /api/alerts?deviceId=`); the others reuse `DeviceDetail.tsx`'s
already-fetched telemetry, grouped by metric. Three seeded device types
(cold-storage-unit, grain-dryer, weather-station) declare `defaultWidgets`
as a working example — adding it to more is a seed-data change, not a code
change, same as adding a vertical.

## Commands

```bash
docker compose up -d              # Postgres + Mosquitto (MQTT) for local dev

npm install                       # installs apps/api + apps/web
cp apps/api/.env.example apps/api/.env   # set JWT_SECRET (openssl rand -hex 32);
                                          # ADMIN_EMAIL/ADMIN_PASSWORD optional, for seeding a user
npm run db:migrate --workspace=apps/api   # apply Prisma schema to Postgres
npm run db:seed --workspace=apps/api      # seed verticals/device types/rules/agents(/admin user)
npm run dev:api                   # apps/api on :4000
npm run dev:web                   # apps/web on :5173
npm run build                     # builds api then web
npm run lint                      # lints api then web

cd apps/workers
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # set ANTHROPIC_API_KEY to enable agents
uvicorn app.main:app --reload --port 8000

python -m scripts.simulate_fleet --interval 5   # optional: simulated telemetry over MQTT
```

Per-workspace commands (run from repo root):

```bash
npm run dev --workspace=apps/api
npm test --workspace=apps/api     # vitest run (hits the real dev Postgres, see apps/api/test/setup.ts)
npm run lint --workspace=apps/web # oxlint
npm run db:studio --workspace=apps/api    # Prisma Studio DB browser
```

Python tests (from `apps/workers`, venv active):

```bash
pip install -r requirements-dev.txt
pytest -v   # unit tests for rule operators + integration tests against real
            # Postgres, each wrapped in a rolled-back transaction (tests/)
```

`apps/api`'s `dev`/`start` scripts load `.env` via Node's `--env-file` flag
(Node 20.6+) — no `dotenv` dependency needed there. `apps/workers` loads
`.env` via `python-dotenv` in `app/main.py`.
