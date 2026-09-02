import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { callWorkers } from "../workersClient.js";

const feedbackSchema = z.object({
  score: z.number().int().min(-1).max(1),
  comment: z.string().optional(),
});

const runAnomalyExplainerSchema = z.object({ alertId: z.string().min(1) });
const runAutomationSuggesterSchema = z.object({ deviceTypeId: z.string().min(1) });

export const agentsRouter = Router();

// Trigger endpoints proxy to apps/workers (only workers calls Claude). This
// keeps agent runs behind the same JWT auth as the rest of /api/*, and keeps
// WORKERS_API_TOKEN server-side — the browser never sees it. See CLAUDE.md.

agentsRouter.post("/anomaly-explainer/run", async (req, res) => {
  const parsed = runAnomalyExplainerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { status, data } = await callWorkers("/agents/anomaly-explainer/run", {
    alert_id: parsed.data.alertId,
  });
  res.status(status).json(data);
});

agentsRouter.post("/alert-triage/run", async (_req, res) => {
  const { status, data } = await callWorkers("/agents/alert-triage/run", {});
  res.status(status).json(data);
});

agentsRouter.post("/automation-suggester/run", async (req, res) => {
  const parsed = runAutomationSuggesterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { status, data } = await callWorkers("/agents/automation-suggester/run", {
    device_type_id: parsed.data.deviceTypeId,
  });
  res.status(status).json(data);
});

agentsRouter.get("/", async (_req, res) => {
  const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
  res.json(agents);
});

agentsRouter.get("/runs", async (req, res) => {
  const agentKey = typeof req.query.agentKey === "string" ? req.query.agentKey : undefined;
  const alertId = typeof req.query.alertId === "string" ? req.query.alertId : undefined;

  const runs = await prisma.agentRun.findMany({
    where: {
      agent: agentKey ? { key: agentKey } : undefined,
      alertId,
    },
    include: { agent: true, alert: true, feedback: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(runs);
});

agentsRouter.post("/runs/:id/feedback", async (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const run = await prisma.agentRun.findUnique({ where: { id: req.params.id } });
  if (!run) {
    res.status(404).json({ error: "Agent run not found" });
    return;
  }

  const feedback = await prisma.agentFeedback.upsert({
    where: { agentRunId: req.params.id },
    update: parsed.data,
    create: { agentRunId: req.params.id, ...parsed.data },
  });
  res.json(feedback);
});
