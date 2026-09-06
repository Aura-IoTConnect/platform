import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

// A user's personal, cross-device watchlist of (device, metric) pins — see
// CLAUDE.md's "Watchlist" section. Every route is scoped to req.user.id;
// there is no admin view of someone else's list.

const addItemSchema = z.object({
  deviceId: z.string().min(1),
  metricKey: z.string().min(1),
});

export const watchlistRouter = Router();

const include = { device: { include: { deviceType: true } } } as const;

watchlistRouter.get("/", async (req, res) => {
  const items = await prisma.watchlistItem.findMany({
    where: { userId: req.user!.id },
    include,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  res.json(items);
});

watchlistRouter.post("/", async (req, res) => {
  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const device = await prisma.device.findUnique({
    where: { id: parsed.data.deviceId },
    include: { deviceType: true },
  });
  if (!device) {
    res.status(400).json({ error: "Unknown deviceId" });
    return;
  }
  const metrics = Array.isArray(device.deviceType.metrics) ? (device.deviceType.metrics as { key?: unknown }[]) : [];
  if (!metrics.some((m) => m?.key === parsed.data.metricKey)) {
    res.status(400).json({ error: "metricKey is not declared by this device's type" });
    return;
  }

  const last = await prisma.watchlistItem.aggregate({ where: { userId: req.user!.id }, _max: { sortOrder: true } });
  try {
    const item = await prisma.watchlistItem.create({
      data: {
        userId: req.user!.id,
        deviceId: device.id,
        metricKey: parsed.data.metricKey,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      include,
    });
    res.status(201).json(item);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "Already on your watchlist" });
      return;
    }
    throw err;
  }
});

watchlistRouter.delete("/:id", async (req, res) => {
  // deleteMany with the userId in the filter so another user's item id
  // is a plain 404, not a cross-user delete.
  const { count } = await prisma.watchlistItem.deleteMany({ where: { id: req.params.id, userId: req.user!.id } });
  if (count === 0) {
    res.status(404).json({ error: "Watchlist item not found" });
    return;
  }
  res.status(204).end();
});
