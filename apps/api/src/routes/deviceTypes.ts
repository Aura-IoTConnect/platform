import { Router } from "express";
import { generateApiKey, hashApiKey } from "../apiKeys.js";
import { prisma } from "../db.js";

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
