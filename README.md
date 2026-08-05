# Aura IoTConnect Platform

Device management and telemetry platform.

## Structure

- `apps/api` — Node.js/Express (TypeScript) REST API for device management and the dashboard's backend.
- `apps/web` — React (Vite + TypeScript) dashboard.
- `apps/workers` — Python/FastAPI service for telemetry ingestion and device data processing.
- `infra/` — local infrastructure config (MQTT broker, etc).

## Getting started

```bash
docker compose up -d          # Postgres + Mosquitto (MQTT broker)
npm install                   # installs apps/api and apps/web
npm run dev:api                # http://localhost:4000
npm run dev:web                # http://localhost:5173

cd apps/workers
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
