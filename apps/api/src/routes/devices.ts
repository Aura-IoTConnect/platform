import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../apiKeys.js";
import { prisma } from "../db.js";
import { callWorkers } from "../workersClient.js";

const createDeviceSchema = z.object({
  name: z.string().min(1),
  deviceTypeId: z.string().min(1),
  location: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const actuatorCommandSchema = z.object({
  command: z.string().min(1),
  value: z.unknown().optional(),
});

export const devicesRouter = Router();

// apiKeyHash is a secret's fingerprint — never send it back, even to admins.
function omitApiKeyHash<T extends { apiKeyHash: string | null }>(device: T): Omit<T, "apiKeyHash"> {
  const { apiKeyHash: _apiKeyHash, ...rest } = device;
  return rest;
}

devicesRouter.get("/", async (_req, res) => {
  const devices = await prisma.device.findMany({
    where: { deletedAt: null },
    include: { deviceType: { include: { vertical: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(devices.map(omitApiKeyHash));
});

devicesRouter.get("/:id", async (req, res) => {
  const device = await prisma.device.findUnique({
    where: { id: req.params.id },
    include: { deviceType: { include: { vertical: true } } },
  });
  if (!device || device.deletedAt) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  res.json(omitApiKeyHash(device));
});

devicesRouter.post("/", async (req, res) => {
  const parsed = createDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const deviceType = await prisma.deviceType.findUnique({
    where: { id: parsed.data.deviceTypeId },
  });
  if (!deviceType) {
    res.status(400).json({ error: "Unknown deviceTypeId" });
    return;
  }

  const apiKey = generateApiKey();
  const device = await prisma.device.create({
    data: {
      ...parsed.data,
      apiKeyHash: hashApiKey(apiKey),
      createdBy: req.user!.id,
    } as Prisma.DeviceUncheckedCreateInput,
    include: { deviceType: { include: { vertical: true } } },
  });
  // apiKey is shown exactly once — the device must store it now, since only
  // its hash is kept from here on.
  res.status(201).json({ ...omitApiKeyHash(device), apiKey });
});

devicesRouter.post("/:id/rotate-key", async (req, res) => {
  const apiKey = generateApiKey();
  try {
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { apiKeyHash: hashApiKey(apiKey), updatedBy: req.user!.id },
    });
    res.json({ ...omitApiKeyHash(device), apiKey });
  } catch {
    res.status(404).json({ error: "Device not found" });
  }
});

// Soft delete: telemetry/alerts/actuator history stays intact, the row just
// stops appearing in reads and apps/workers stops accepting ingestion for
// it (see CLAUDE.md). Idempotent — deleting an already-deleted device just
// re-sets deletedAt rather than erroring.
devicesRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.device.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), updatedBy: req.user!.id },
    });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: "Device not found" });
  }
});

// Proxies to apps/workers server-side (WORKERS_API_TOKEN never reaches the
// browser) — same pattern as the agent-trigger routes. See CLAUDE.md.
devicesRouter.post("/:id/actuator", async (req, res) => {
  const parsed = actuatorCommandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { status, data } = await callWorkers(`/devices/${req.params.id}/actuator`, parsed.data);
  res.status(status).json(data);
});
