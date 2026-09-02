import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

const createRuleSchema = z.object({
  deviceTypeId: z.string().min(1),
  name: z.string().min(1),
  metric: z.string().min(1),
  operator: z.enum(["GT", "GTE", "LT", "LTE", "EQ"]),
  threshold: z.number(),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]).default("WARNING"),
  actionType: z.enum(["notify", "webhook", "actuator"]),
  actionConfig: z.record(z.unknown()).optional(),
});

const updateRuleSchema = z.object({
  enabled: z.boolean(),
});

export const rulesRouter = Router();

rulesRouter.get("/", async (req, res) => {
  const deviceTypeId = typeof req.query.deviceTypeId === "string" ? req.query.deviceTypeId : undefined;
  const rules = await prisma.rule.findMany({
    where: { deviceTypeId, deletedAt: null },
    include: { deviceType: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(rules);
});

rulesRouter.post("/", async (req, res) => {
  const parsed = createRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const deviceType = await prisma.deviceType.findUnique({ where: { id: parsed.data.deviceTypeId } });
  if (!deviceType) {
    res.status(400).json({ error: "Unknown deviceTypeId" });
    return;
  }

  const rule = await prisma.rule.create({
    data: { ...parsed.data, createdBy: req.user!.id } as Prisma.RuleUncheckedCreateInput,
  });
  res.status(201).json(rule);
});

rulesRouter.patch("/:id", async (req, res) => {
  const parsed = updateRuleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const rule = await prisma.rule.update({
      where: { id: req.params.id },
      data: { enabled: parsed.data.enabled, updatedBy: req.user!.id },
    });
    res.json(rule);
  } catch {
    res.status(404).json({ error: "Rule not found" });
  }
});

// Soft delete — see devices.ts's DELETE /:id for the rationale. Critically,
// apps/workers' rule_engine.py excludes deletedAt != null rules from
// matching, so a deleted rule stops firing even if it was left enabled.
rulesRouter.delete("/:id", async (req, res) => {
  try {
    await prisma.rule.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), updatedBy: req.user!.id },
    });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: "Rule not found" });
  }
});
