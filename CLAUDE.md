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
  MQTT ingestion is gated separately, at the broker: Mosquitto requires a
  username/password (`infra/mosquitto.passwd` + `mosquitto.acl`, mounted by
  `docker-compose.yml`) restricted to the `telemetry/#` topic namespace —
  one shared credential for every publisher, not per-device like the HTTP
  path's `Device.apiKeyHash`. Set via `MQTT_USERNAME`/`MQTT_PASSWORD` in
  `apps/workers/.env` (the subscriber) and the same in whatever publishes
  (e.g. `scripts/simulate_fleet.py`). Real per-device MQTT auth would need
  Mosquitto's dynamic-security plugin or per-client certs — not implemented.

Don't assume a request reaching `apps/workers` was authenticated as a
specific user — at most it proves possession of a device's key or the one
shared token.

### The two loops

1. **Control loop** (SCADA-style, `apps/workers/app/rule_engine.py`, entered
   via `app/telemetry_service.py::ingest_reading`): sense (telemetry ingested,
   HTTP or MQTT) → analyze (rules for that device's type + metric) → decide
   (threshold breached?) → act (create `Alert`, dispatch `notify` (logged) /
   `webhook` (a real HTTP POST — see below) / `actuator` (persisted — see
   below)) → next reading.
2. **Agent feedback loop**: an `AgentRun`'s output can be scored via
   `AgentFeedback` (`POST /api/agents/runs/:id/feedback`), so agent quality
   is trackable over time instead of being a one-shot, unverified suggestion.

### Alert dedup, auto-clear, and notify cooldown

`rule_engine.py::evaluate` keeps at most one active (`OPEN`/`ACKNOWLEDGED`)
`Alert` per `(device, rule)` pair instead of inserting a new row on every
breaching reading — it looks up the most recent alert for that pair first:

- **Already active + still breaching**: no new `Alert` row, no repeat
  notify/webhook dispatch (actuator dispatch is the one exception — see
  Actuator control below, it's a continuous control signal, not a
  notification, so it fires on every breaching reading regardless).
- **Active but reading no longer breaches**: auto-cleared — `status` →
  `RESOLVED`, `resolvedAt` set — rather than left for an operator to close
  by hand.
- **No active alert + breaching**: a new episode. A new `Alert` row is
  always created (for history), but if the *previous* episode for this pair
  notified within `NOTIFY_COOLDOWN_SECONDS` (env var, default 300s, checked
  against `Alert.lastNotifiedAt`), this episode's notify/webhook dispatch is
  suppressed — flapping-protection for a metric oscillating around its
  threshold, without losing the alert history.

`webhook` actionType dispatch (`apps/workers/app/webhook_service.py`) is a
real `httpx` POST of `{ruleId, ruleName, deviceId, metric, value, severity,
alertId}` to `Rule.actionConfig.url`, best-effort like every other external
call in this project (timeout + logged failure, never raised) — it used to
just be a log line. `notify` actionType is still logged only, not a real
delivery channel (email/SMS/Slack) — not implemented.

Because this dispatch involves real network I/O, `evaluate()` never makes
the HTTP call itself — it hands back a `pendingWebhook` (`{url, payload}` or
`None`) per created alert, and `telemetry_service.py::ingest_reading`
dispatches it *after* its DB transaction commits, the same reason the
CRITICAL → `anomaly-explainer` trigger already happens post-transaction:
neither a webhook call nor an LLM call should hold a DB connection open.

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
