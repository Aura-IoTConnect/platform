import { Router } from "express";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "../apiKeys.js";
import { prisma } from "../db.js";
import { callWorkers } from "../workersClient.js";

export const deviceTypesRouter = Router();

// provisionSecretHash is a secret's fingerprint — never send it back, even
// to admins. provisionKey itself isn't secret (it's a public lookup
// identifier, like a client ID meant to be embedded in firmware), so it's
// fine to include in normal responses.
function omitProvisionSecretHash<T extends { provisionSecretHash: string | null }>(
  deviceType: T,
): Omit<T, "provisionSecretHash"> {
  const { provisionSecretHash: _provisionSecretHash, ...rest } = deviceType;
  return rest;
}

deviceTypesRouter.get("/", async (req, res) => {
  const verticalId = typeof req.query.verticalId === "string" ? req.query.verticalId : undefined;
  const deviceTypes = await prisma.deviceType.findMany({
    where: verticalId ? { verticalId } : undefined,
    include: { vertical: true, rules: true },
    orderBy: { name: "asc" },
  });
  res.json(deviceTypes.map(omitProvisionSecretHash));
});

deviceTypesRouter.get("/:id", async (req, res) => {
  const deviceType = await prisma.deviceType.findUnique({
    where: { id: req.params.id },
    include: { vertical: true, rules: true },
  });
  if (!deviceType) {
    res.status(404).json({ error: "Device type not found" });
    return;
  }
  res.json(omitProvisionSecretHash(deviceType));
});

// Generates (or rotates) this device type's self-service provisioning
// credential — see CLAUDE.md's "Self-service device provisioning" section.
// Like device api-key rotation, the raw secret is shown exactly once here;
// only its hash is stored, and calling this again invalidates the old pair.
deviceTypesRouter.post("/:id/provisioning-secret", async (req, res) => {
  const provisionKey = generateApiKey();
  const provisionSecret = generateApiKey();
  try {
    await prisma.deviceType.update({
      where: { id: req.params.id },
      data: { provisionKey, provisionSecretHash: hashApiKey(provisionSecret) },
    });
    res.json({ provisionKey, provisionSecret });
  } catch {
    res.status(404).json({ error: "Device type not found" });
  }
});

const actuatorCommandSchema = z.object({
  command: z.string().min(1),
  value: z.unknown().optional(),
});

// Fan one manual command out to every device of this type — the app-layer
// analogue of a broker-level "channel" (see CLAUDE.md, Actuator control).
// Each device still goes through the existing per-device workers endpoint,
// so each dispatch writes its own ActuatorCommand row (source: MANUAL).
// Always 200 with a per-device result list: a partial failure (one
// device's workers call 502s) must not read as either full success or
// full failure.
deviceTypesRouter.post("/:id/actuator", async (req, res) => {
  const parsed = actuatorCommandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const deviceType = await prisma.deviceType.findUnique({ where: { id: req.params.id } });
  if (!deviceType) {
    res.status(404).json({ error: "Device type not found" });
    return;
  }

  const targets = await prisma.device.findMany({
    where: { deviceTypeId: deviceType.id },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const results = [];
  for (const device of targets) {
    const { status, data } = await callWorkers(`/devices/${device.id}/actuator`, parsed.data);
    results.push({ deviceId: device.id, deviceName: device.name, ok: status >= 200 && status < 300, status, data });
  }
  res.json({
    deviceTypeId: deviceType.id,
    command: parsed.data.command,
    dispatched: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});
