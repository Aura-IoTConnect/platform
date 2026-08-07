# Aura IoTConnect Platform

<!-- branch-protection-test: harmless comment, safe to merge or discard -->


A generic, AI-driven IoT/SCADA platform: device monitoring, telemetry,
closed-loop automation, and Claude-powered agents across many verticals
(agri-processing, weather, cold storage, smart home/office, warehousing,
e-health, smart metering, manufacturing, water treatment, mining, security,
transportation, smart city, energy/solar). Verticals are seed data, not
separate code — see `CLAUDE.md` for the architecture.

## Structure

- `apps/api` — Node.js/Express + TypeScript. Owns the schema (Prisma) and
  REST endpoints for verticals, device types, devices, telemetry (read),
  rules, alerts, and agent runs/feedback.
- `apps/web` — React (Vite + TypeScript) dashboard: Devices / Alerts / Agent
  Runs tabs.
- `apps/workers` — Python/FastAPI service: telemetry ingestion, the rule
  (control-loop) engine, and AI agent execution (Anthropic API).
- `infra/` — local infrastructure config (MQTT broker, etc).

## Getting started

```bash
docker compose up -d          # Postgres + Mosquitto (MQTT broker)
npm install                   # installs apps/api and apps/web

cp apps/api/.env.example apps/api/.env
npm run db:migrate --workspace=apps/api   # create tables
npm run db:seed --workspace=apps/api      # seed verticals/device types/rules/agents

npm run dev:api                # http://localhost:4000
npm run dev:web                # http://localhost:5173

cd apps/workers
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # set ANTHROPIC_API_KEY to enable AI agents
uvicorn app.main:app --reload --port 8000
```

Without `ANTHROPIC_API_KEY`, everything else works normally — agent
endpoints just return `503` instead of calling Claude.

### Try the closed loop

```bash
# breach the seeded cold-storage freeze-alarm rule (device id from `GET /api/devices`)
curl -X POST http://localhost:8000/ingestion/telemetry \
  -H 'content-type: application/json' \
  -d '{"device_id":"<cold-storage-device-id>","metric":"temperature","value":-2.5}'
```

This persists the reading, evaluates the seeded rule, and creates an `Alert`
visible in the dashboard's Alerts tab (and, if `ANTHROPIC_API_KEY` is set,
auto-runs the `anomaly-explainer` agent since the rule is CRITICAL severity).
