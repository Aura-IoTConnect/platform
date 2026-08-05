# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Three-service platform, no shared package between them yet:

- `apps/api` — Node.js/Express + TypeScript. Owns device management REST endpoints and serves as the dashboard's backend. In-memory storage for now (`apps/api/src/routes/devices.ts`) — swap for Postgres as persistence is added.
- `apps/web` — React + Vite + TypeScript dashboard (scaffolded via `create-vite react-ts`).
- `apps/workers` — Python/FastAPI. Owns telemetry ingestion and device data processing, decoupled from the Node API so protocol/data workloads (MQTT, batch processing) don't block the request/response API.
- `infra/mosquitto.conf` — local MQTT broker config used by `docker-compose.yml`.

`apps/api` and `apps/web` are npm workspaces under the root `package.json`; `apps/workers` is a standalone Python project (own venv/requirements.txt), not part of the npm workspace.

## Commands

```bash
docker compose up -d              # Postgres + Mosquitto (MQTT) for local dev

npm install                       # installs apps/api + apps/web
npm run dev:api                   # apps/api on :4000
npm run dev:web                   # apps/web on :5173
npm run build                     # builds api then web
npm run lint                      # lints api then web

cd apps/workers
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Per-workspace commands (run from repo root):

```bash
npm run dev --workspace=apps/api
npm test --workspace=apps/api     # vitest run
npm run lint --workspace=apps/web # oxlint
```
