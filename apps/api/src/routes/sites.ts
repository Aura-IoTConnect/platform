import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";

// A physical/logical location hierarchy for grouping devices (e.g. "Region >
// Facility > Room") — distinct from Device.location (free-text label) and
// from the one-level-only gateway/child Device hierarchy. See CLAUDE.md's
// "Grouping, tags & bulk import/export" section. Arbitrary nesting depth is
// allowed (unlike the gateway hierarchy), so there's no equivalent of
// validateParentAssignment here beyond "not your own ancestor".

const createSiteSchema = z.object({
  name: z.string().min(1),
  parentSiteId: z.string().min(1).nullable().optional(),
});

const updateSiteSchema = z.object({
  name: z.string().min(1).optional(),
  parentSiteId: z.string().min(1).nullable().optional(),
});

export const sitesRouter = Router();

// Walks parentSite pointers from `candidateParentId` upward, refusing if it
// ever reaches `siteId` — that would make siteId its own ancestor. Depth is
// unbounded in principle, but real site trees are shallow (a handful of
// levels), so no cap is needed.
async function wouldCreateCycle(siteId: string, candidateParentId: string): Promise<boolean> {
  let cursor: string | null = candidateParentId;
  while (cursor !== null) {
    if (cursor === siteId) return true;
    const site: { parentSiteId: string | null } | null = await prisma.site.findUnique({
      where: { id: cursor },
      select: { parentSiteId: true },
    });
    if (!site) break;
    cursor = site.parentSiteId;
  }
  return false;
}

sitesRouter.get("/", async (_req, res) => {
  const sites = await prisma.site.findMany({ orderBy: { name: "asc" } });
  res.json(sites);
});

sitesRouter.post("/", async (req, res) => {
  const parsed = createSiteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.parentSiteId) {
    const parent = await prisma.site.findUnique({ where: { id: parsed.data.parentSiteId } });
    if (!parent) {
      res.status(400).json({ error: "Unknown parentSiteId" });
      return;
    }
  }
  const site = await prisma.site.create({ data: parsed.data });
  res.status(201).json(site);
});

sitesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSiteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (typeof parsed.data.parentSiteId === "string") {
    if (parsed.data.parentSiteId === req.params.id) {
      res.status(400).json({ error: "A site cannot be its own parent" });
      return;
    }
    const parent = await prisma.site.findUnique({ where: { id: parsed.data.parentSiteId } });
    if (!parent) {
      res.status(400).json({ error: "Unknown parentSiteId" });
      return;
    }
    if (await wouldCreateCycle(req.params.id, parsed.data.parentSiteId)) {
      res.status(400).json({ error: "That would create a cycle in the site hierarchy" });
      return;
    }
  }
  try {
    const site = await prisma.site.update({ where: { id: req.params.id }, data: parsed.data });
    res.json(site);
  } catch {
    res.status(404).json({ error: "Site not found" });
  }
});

// Refuses to delete a site that's still in use (has devices or child sites)
// rather than silently orphaning them via onDelete: SetNull — a grouping
// disappearing out from under devices/sub-sites without the operator
// noticing would be surprising; detach explicitly first.
sitesRouter.delete("/:id", async (req, res) => {
  const [deviceCount, childCount] = await Promise.all([
    prisma.device.count({ where: { siteId: req.params.id } }),
    prisma.site.count({ where: { parentSiteId: req.params.id } }),
  ]);
  if (deviceCount > 0 || childCount > 0) {
    res.status(400).json({ error: "Site has devices or child sites attached — detach them first" });
    return;
  }
  const { count } = await prisma.site.deleteMany({ where: { id: req.params.id } });
  if (count === 0) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  res.status(204).end();
});
