import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-rules@iotplatform.local";

describe("POST /api/rules/backtest", () => {
  let token: string;
  let deviceTypeId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
    deviceTypeId = (await prisma.deviceType.findFirstOrThrow()).id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("requires a bearer token", async () => {
    const res = await request(app).post("/api/rules/backtest").send({});
    expect(res.status).toBe(401);
  });

  it("validates the body", async () => {
    const res = await request(app)
      .post("/api/rules/backtest")
      .set("authorization", `Bearer ${token}`)
      .send({ deviceTypeId, metric: "temperature", operator: "BETWEEN", threshold: 1 });
    expect(res.status).toBe(400);
  });

  it("proxies to apps/workers without crashing when workers is unreachable", async () => {
    // CI doesn't run apps/workers, so this exercises the 502 path.
    const res = await request(app)
      .post("/api/rules/backtest")
      .set("authorization", `Bearer ${token}`)
      .send({ deviceTypeId, metric: "temperature", operator: "GT", threshold: 10 });
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) expect(typeof res.body.estimatedEpisodes).toBe("number");

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
  });
});
