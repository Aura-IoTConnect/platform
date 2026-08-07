import { Router } from "express";
import { prisma } from "../db.js";

export const verticalsRouter = Router();

verticalsRouter.get("/", async (_req, res) => {
  const verticals = await prisma.vertical.findMany({
    include: { deviceTypes: true },
    orderBy: { name: "asc" },
  });
  res.json(verticals);
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
  res.json(vertical);
});
