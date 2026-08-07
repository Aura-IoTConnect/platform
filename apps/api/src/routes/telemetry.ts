import { Router } from "express";
import { prisma } from "../db.js";

export const telemetryRouter = Router();

// Read-only: telemetry is written by apps/workers as readings are ingested.
telemetryRouter.get("/", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
  if (!deviceId) {
    res.status(400).json({ error: "deviceId query param is required" });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const readings = await prisma.telemetryReading.findMany({
    where: { deviceId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  res.json(readings);
});
