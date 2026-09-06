import cors from "cors";
import express from "express";
import { requireAuth } from "./auth.js";
import { metricsHandler, metricsMiddleware } from "./metrics.js";
import { actuatorCommandsRouter } from "./routes/actuatorCommands.js";
import { agentsRouter } from "./routes/agents.js";
import { alertsRouter } from "./routes/alerts.js";
import { authRouter } from "./routes/auth.js";
import { deviceTypesRouter } from "./routes/deviceTypes.js";
import { devicesRouter } from "./routes/devices.js";
import { rulesRouter } from "./routes/rules.js";
import { telemetryRouter } from "./routes/telemetry.js";
import { verticalsRouter } from "./routes/verticals.js";
import { watchlistRouter } from "./routes/watchlist.js";

export const app = express();

app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Prometheus exposition — deliberately outside /api and its JWT middleware
// (a scraper carries no user token), same carve-out as /health. Ops data
// about this service, not device/user data. See src/metrics.ts.
app.get("/metrics", metricsHandler);

app.use("/api/auth", authRouter);

// Everything else requires a logged-in dashboard/API user. apps/workers
// writes telemetry/alerts/agent runs directly to Postgres, not through this
// API, so it's unaffected by this middleware.
app.use("/api", requireAuth);

app.use("/api/verticals", verticalsRouter);
app.use("/api/device-types", deviceTypesRouter);
app.use("/api/devices", devicesRouter);
app.use("/api/telemetry", telemetryRouter);
app.use("/api/actuator-commands", actuatorCommandsRouter);
app.use("/api/rules", rulesRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/watchlist", watchlistRouter);
