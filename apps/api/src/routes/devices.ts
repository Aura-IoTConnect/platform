import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { generateApiKey, hashApiKey } from "../apiKeys.js";
import { prisma } from "../db.js";

const createDeviceSchema = z.object({
  name: z.string().min(1),
  deviceTypeId: z.string().min(1),
  location: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const devicesRouter = Router();

// apiKeyHash is a secret's fingerprint — never send it back, even to admins.
function omitApiKeyHash<T extends { apiKeyHash: string | null }>(device: T): Omit<T, "apiKeyHash"> {
  const { apiKeyHash: _apiKeyHash, ...rest } = device;
  return rest;
}

devicesRouter.get("/", async (_req, res) => {
  const devices = await prisma.device.findMany({
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
  if (!device) {
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
    data: { ...parsed.data, apiKeyHash: hashApiKey(apiKey) } as Prisma.DeviceUncheckedCreateInput,
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
      data: { apiKeyHash: hashApiKey(apiKey) },
    });
    res.json({ ...omitApiKeyHash(device), apiKey });
  } catch {
    res.status(404).json({ error: "Device not found" });
  }
});
