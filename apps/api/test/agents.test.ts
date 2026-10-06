import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

// The trigger routes only translate the request and forward it to
// apps/workers (the only place Claude is called). Mock the forwarding seam so
// these tests pin down exactly what is sent and how the answer is relayed,
// without depending on whether a workers process happens to be running.
vi.mock("../src/workersClient.js", () => ({ callWorkers: vi.fn() }));
import { callWorkers } from "../src/workersClient.js";

const TEST_EMAIL = "vitest-agents@iotplatform.local";

describe("/api/agents", () => {
  let auth: { authorization: string };
  let agentId: string;
  let agentKey: string;
  let runId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    auth = { authorization: `Bearer ${signToken({ id: user.id, email: user.email, role: user.role })}` };

    agentKey = `vitest-agent-${Date.now()}`;
    const agent = await prisma.agent.create({
      data: { key: agentKey, name: "vitest agent", description: "test", systemPrompt: "test" },
    });
    agentId = agent.id;
    const run = await prisma.agentRun.create({ data: { agentId, input: { q: "hi" }, status: "COMPLETED" } });
    runId = run.id;
  });

  afterAll(async () => {
    await prisma.agentFeedback.deleteMany({ where: { agentRunId: runId } });
    await prisma.agentRun.deleteMany({ where: { agentId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.mocked(callWorkers).mockReset();
  });

  it("requires a bearer token", async () => {
    expect((await request(app).get("/api/agents")).status).toBe(401);
    expect((await request(app).post("/api/agents/alert-triage/run")).status).toBe(401);
  });

  it("lists agents", async () => {
    const res = await request(app).get("/api/agents").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.some((a: { key: string }) => a.key === agentKey)).toBe(true);
  });

  describe("trigger proxies", () => {
    it("anomaly-explainer maps alertId -> alert_id and relays workers' answer verbatim", async () => {
      vi.mocked(callWorkers).mockResolvedValueOnce({ status: 200, data: { runId: "r1" } });

      const res = await request(app).post("/api/agents/anomaly-explainer/run").set(auth).send({ alertId: "a1" });

      expect(callWorkers).toHaveBeenCalledWith("/agents/anomaly-explainer/run", { alert_id: "a1" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runId: "r1" });
    });

    it("anomaly-explainer rejects a missing alertId without calling workers", async () => {
      const res = await request(app).post("/api/agents/anomaly-explainer/run").set(auth).send({});
      expect(res.status).toBe(400);
      expect(callWorkers).not.toHaveBeenCalled();
    });

    it("automation-suggester maps deviceTypeId -> device_type_id", async () => {
      vi.mocked(callWorkers).mockResolvedValueOnce({ status: 200, data: {} });

      await request(app).post("/api/agents/automation-suggester/run").set(auth).send({ deviceTypeId: "dt1" });

      expect(callWorkers).toHaveBeenCalledWith("/agents/automation-suggester/run", { device_type_id: "dt1" });
    });

    it("automation-suggester rejects a missing deviceTypeId", async () => {
      const res = await request(app).post("/api/agents/automation-suggester/run").set(auth).send({});
      expect(res.status).toBe(400);
      expect(callWorkers).not.toHaveBeenCalled();
    });

    it("alert-triage takes no body and forwards an empty one", async () => {
      vi.mocked(callWorkers).mockResolvedValueOnce({ status: 200, data: { ranked: [] } });

      const res = await request(app).post("/api/agents/alert-triage/run").set(auth);

      expect(callWorkers).toHaveBeenCalledWith("/agents/alert-triage/run", {});
      expect(res.body).toEqual({ ranked: [] });
    });

    it("passes workers' 503 (agents not configured) through to the browser unchanged", async () => {
      vi.mocked(callWorkers).mockResolvedValueOnce({ status: 503, data: { detail: "ANTHROPIC_API_KEY missing" } });

      const res = await request(app).post("/api/agents/alert-triage/run").set(auth);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ detail: "ANTHROPIC_API_KEY missing" });
    });

    it("passes a 502 (workers unreachable) through too", async () => {
      vi.mocked(callWorkers).mockResolvedValueOnce({ status: 502, data: { error: "apps/workers is unreachable" } });

      const res = await request(app).post("/api/agents/alert-triage/run").set(auth);

      expect(res.status).toBe(502);
    });
  });

  describe("runs", () => {
    it("lists runs, filterable by agent key", async () => {
      const res = await request(app).get(`/api/agents/runs?agentKey=${agentKey}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].agent.key).toBe(agentKey);

      const none = await request(app).get("/api/agents/runs?agentKey=no-such-agent").set(auth);
      expect(none.body).toEqual([]);
    });
  });

  describe("POST /runs/:id/feedback", () => {
    it("rejects a score outside -1..1 and a non-integer", async () => {
      for (const score of [2, -2, 0.5]) {
        const res = await request(app).post(`/api/agents/runs/${runId}/feedback`).set(auth).send({ score });
        expect(res.status).toBe(400);
      }
    });

    it("404s for an unknown run", async () => {
      const res = await request(app).post("/api/agents/runs/does-not-exist/feedback").set(auth).send({ score: 1 });
      expect(res.status).toBe(404);
    });

    it("records feedback, and a second submission updates it instead of adding a row", async () => {
      const first = await request(app)
        .post(`/api/agents/runs/${runId}/feedback`)
        .set(auth)
        .send({ score: 1, comment: "useful" });
      expect(first.status).toBe(200);
      expect(first.body.score).toBe(1);

      const second = await request(app).post(`/api/agents/runs/${runId}/feedback`).set(auth).send({ score: -1 });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id); // same row, upserted
      expect(second.body.score).toBe(-1);

      expect(await prisma.agentFeedback.count({ where: { agentRunId: runId } })).toBe(1);
    });
  });
});
