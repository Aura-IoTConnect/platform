import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";

const updateAlertSchema = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]),
});

export const alertsRouter = Router();

alertsRouter.get("/", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;

  const alerts = await prisma.alert.findMany({
    where: {
      status: status as "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | undefined,
      deviceId,
    },
    include: { device: { include: { deviceType: { include: { vertical: true } } } }, rule: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(alerts);
});

alertsRouter.patch("/:id", async (req, res) => {
  const parsed = updateAlertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const alert = await prisma.alert.update({
      where: { id: req.params.id },
      data: {
        status: parsed.data.status,
        resolvedAt: parsed.data.status === "RESOLVED" ? new Date() : null,
        updatedBy: req.user!.id,
      },
    });
    res.json(alert);
  } catch {
    res.status(404).json({ error: "Alert not found" });
  }
});
