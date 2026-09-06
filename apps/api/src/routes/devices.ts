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

// Same idea, for the nested deviceType's provisioning secret hash — every
// route here that includes { deviceType: ... } must strip this too, or it
// leaks the device type's provisioning credential fingerprint through a
// device response even though deviceTypes.ts already hides it from its own
// routes. Only call this where `deviceType` was actually included.
function omitNestedProvisionSecretHash<T extends { deviceType: { provisionSecretHash: string | null } }>(
  device: T,
): T & { deviceType: Omit<T["deviceType"], "provisionSecretHash"> } {
  const { provisionSecretHash: _provisionSecretHash, ...deviceTypeRest } = device.deviceType;
  return { ...device, deviceType: deviceTypeRest } as T & { deviceType: Omit<T["deviceType"], "provisionSecretHash"> };
}

// Best-effort: MQTT provisioning is a nice-to-have layered on top of the
// HTTP apiKeyHash (the source of truth), not a hard dependency — a device
// still works over HTTP ingestion even if apps/workers or the broker is
// down when this fires. Callers get a boolean back purely for UI feedback,
// never a failed HTTP response.
async function provisionMqttCredentials(deviceId: string, password: string): Promise<boolean> {
  const { status } = await callWorkers(`/devices/${deviceId}/mqtt-credentials`, { password });
  if (status >= 200 && status < 300) return true;
  console.warn(`MQTT credential provisioning failed for device=${deviceId} (status=${status})`);
  return false;
}

devicesRouter.get("/", async (_req, res) => {
  const devices = await prisma.device.findMany({
    include: { deviceType: { include: { vertical: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(devices.map(omitApiKeyHash).map(omitNestedProvisionSecretHash));
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
  res.json(omitNestedProvisionSecretHash(omitApiKeyHash(device)));
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
  const mqttProvisioned = await provisionMqttCredentials(device.id, apiKey);
  // apiKey is shown exactly once — the device must store it now, since only
  // its hash is kept from here on. Same key works for HTTP and MQTT ingestion.
  res.status(201).json({ ...omitNestedProvisionSecretHash(omitApiKeyHash(device)), apiKey, mqttProvisioned });
});

devicesRouter.post("/:id/rotate-key", async (req, res) => {
  const apiKey = generateApiKey();
  try {
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: { apiKeyHash: hashApiKey(apiKey) },
    });
    const mqttProvisioned = await provisionMqttCredentials(device.id, apiKey);
    res.json({ ...omitApiKeyHash(device), apiKey, mqttProvisioned });
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
