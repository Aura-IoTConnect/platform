import { Router } from "express";
import { prisma } from "../db.js";

export const actuatorCommandsRouter = Router();

// Read-only: commands are written by apps/workers (app/actuator_service.py),
// either from a rule breach or the POST /api/devices/:id/actuator proxy.
actuatorCommandsRouter.get("/", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
  if (!deviceId) {
    res.status(400).json({ error: "deviceId query param is required" });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const commands = await prisma.actuatorCommand.findMany({
    where: { deviceId },
    include: { rule: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json(commands);
});
