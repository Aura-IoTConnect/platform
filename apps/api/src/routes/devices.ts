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

// Device creation stays minimal (above); lifecycle/serviceability fields
// are set afterward via PATCH — a device is rarely commissioned with a
// known firmware version/warranty date at the exact moment its row is
// created. All optional, all independently updatable.
const updateDeviceSchema = z.object({
  name: z.string().min(1).optional(),
  location: z.string().nullable().optional(),
  firmwareVersion: z.string().nullable().optional(),
  hardwareModel: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  commissionedAt: z.coerce.date().nullable().optional(),
  warrantyExpiresAt: z.coerce.date().nullable().optional(),
  parentDeviceId: z.string().min(1).nullable().optional(),
});

const serviceLogEntrySchema = z.object({
  note: z.string().min(1),
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

// Gateway/child hierarchy is deliberately one level only — a gateway's own
// `parentDeviceId` must be null, and a device that already has children
// can't be attached under another device. Enforced here rather than in the
// schema (Postgres has no clean "self-referential depth <= 1" constraint).
// Returns an error string, or null if the assignment is valid.
async function validateParentAssignment(deviceId: string, parentDeviceId: string): Promise<string | null> {
  if (parentDeviceId === deviceId) {
    return "A device cannot be its own parent";
  }
  const parent = await prisma.device.findUnique({
    where: { id: parentDeviceId },
    select: { parentDeviceId: true },
  });
  if (!parent) {
    return "Unknown parentDeviceId";
  }
  if (parent.parentDeviceId !== null) {
    return "parentDeviceId already has a parent of its own — hierarchy is one level only";
  }
  const existingChild = await prisma.device.findFirst({
    where: { parentDeviceId: deviceId },
    select: { id: true },
  });
  if (existingChild) {
    return "This device already has child devices and cannot itself become a child";
  }
  return null;
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

// childDevices is summary-only (id/name/status) — a full nested Device would
// re-leak apiKeyHash/provisionSecretHash and isn't needed for the gateway UI,
// which just lists attached sub-devices by name/status.
const childDeviceSummary = { select: { id: true, name: true, status: true } };

devicesRouter.get("/", async (_req, res) => {
  const devices = await prisma.device.findMany({
    include: { deviceType: { include: { vertical: true } }, childDevices: childDeviceSummary },
    orderBy: { createdAt: "desc" },
  });
  res.json(devices.map(omitApiKeyHash).map(omitNestedProvisionSecretHash));
});

devicesRouter.get("/:id", async (req, res) => {
  const device = await prisma.device.findUnique({
    where: { id: req.params.id },
    include: { deviceType: { include: { vertical: true } }, childDevices: childDeviceSummary },
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

// Lifecycle/serviceability metadata update — the one generic way to change
// an existing device's editable fields (name, location, firmware/hardware
// info, commissioning/warranty dates). See CLAUDE.md's "Device lifecycle &
// service log" section.
devicesRouter.patch("/:id", async (req, res) => {
  const parsed = updateDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (typeof parsed.data.parentDeviceId === "string") {
    const error = await validateParentAssignment(req.params.id, parsed.data.parentDeviceId);
    if (error) {
      res.status(400).json({ error });
      return;
    }
  }

  try {
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: parsed.data,
      include: { deviceType: { include: { vertical: true } }, childDevices: childDeviceSummary },
    });
    res.json(omitNestedProvisionSecretHash(omitApiKeyHash(device)));
  } catch {
    res.status(404).json({ error: "Device not found" });
  }
});

devicesRouter.get("/:id/service-log", async (req, res) => {
  const known = await prisma.device.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!known) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  const entries = await prisma.serviceLogEntry.findMany({
    where: { deviceId: req.params.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(entries);
});

devicesRouter.post("/:id/service-log", async (req, res) => {
  const parsed = serviceLogEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const known = await prisma.device.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!known) {
    res.status(404).json({ error: "Device not found" });
    return;
  }

  const entry = await prisma.serviceLogEntry.create({
    data: { deviceId: req.params.id, note: parsed.data.note, createdBy: req.user!.email },
  });
  res.status(201).json(entry);
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
