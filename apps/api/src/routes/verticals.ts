import { Router } from "express";
import { prisma } from "../db.js";
import { omitProvisionSecretHash } from "../sanitize.js";

export const verticalsRouter = Router();

// Nested deviceTypes carry provisionSecretHash — strip it, same as
// deviceTypes.ts does for its own routes.
function withSafeDeviceTypes<T extends { deviceTypes: { provisionSecretHash: string | null }[] }>(vertical: T) {
  return { ...vertical, deviceTypes: vertical.deviceTypes.map(omitProvisionSecretHash) };
}

verticalsRouter.get("/", async (_req, res) => {
  const verticals = await prisma.vertical.findMany({
    include: { deviceTypes: true },
    orderBy: { name: "asc" },
  });
  res.json(verticals.map(withSafeDeviceTypes));
});

verticalsRouter.get("/:id", async (req, res) => {
  const vertical = await prisma.vertical.findUnique({
    where: { id: req.params.id },
    include: { deviceTypes: true },
  });
  if (!vertical) {
    res.status(404).json({ error: "Vertical not found" });
    return;
  }
  res.json(withSafeDeviceTypes(vertical));
});
