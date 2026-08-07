import { Router } from "express";
import { prisma } from "../db.js";

export const deviceTypesRouter = Router();

deviceTypesRouter.get("/", async (req, res) => {
  const verticalId = typeof req.query.verticalId === "string" ? req.query.verticalId : undefined;
  const deviceTypes = await prisma.deviceType.findMany({
    where: verticalId ? { verticalId } : undefined,
    include: { vertical: true, rules: true },
    orderBy: { name: "asc" },
  });
  res.json(deviceTypes);
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
  res.json(deviceType);
});
