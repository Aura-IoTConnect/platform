import cors from "cors";
import express from "express";
import { agentsRouter } from "./routes/agents.js";
import { alertsRouter } from "./routes/alerts.js";
import { deviceTypesRouter } from "./routes/deviceTypes.js";
import { devicesRouter } from "./routes/devices.js";
import { rulesRouter } from "./routes/rules.js";
import { telemetryRouter } from "./routes/telemetry.js";
import { verticalsRouter } from "./routes/verticals.js";

const app = express();
const port = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/verticals", verticalsRouter);
app.use("/api/device-types", deviceTypesRouter);
app.use("/api/devices", devicesRouter);
app.use("/api/telemetry", telemetryRouter);
app.use("/api/rules", rulesRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/agents", agentsRouter);

app.listen(port, () => {
  console.log(`api listening on port ${port}`);
});
