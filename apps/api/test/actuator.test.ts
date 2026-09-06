import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-actuator@iotplatform.local";

describe("actuator routes", () => {
  let token: string;
  let deviceId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });

    const device = await prisma.device.findFirstOrThrow();
    deviceId = device.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("rejects an actuator command with no bearer token", async () => {
    const res = await request(app).post(`/api/devices/${deviceId}/actuator`).send({ command: "x" });
    expect(res.status).toBe(401);
  });

  it("rejects an actuator command with no command field", async () => {
    const res = await request(app)
      .post(`/api/devices/${deviceId}/actuator`)
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("proxies without crashing the process when apps/workers is unreachable", async () => {
    // Regression test: callWorkers() used to let a fetch()-level rejection
    // (workers down / wrong WORKERS_URL) escape as an unhandled promise
    // rejection — Express 4 doesn't catch async route errors, so this could
    // take the whole process down instead of returning a normal response.
    // CI doesn't run apps/workers, so this exercises exactly that path.
    const res = await request(app)
      .post(`/api/devices/${deviceId}/actuator`)
      .set("authorization", `Bearer ${token}`)
      .send({ command: "test" });
    expect([200, 502]).toContain(res.status);

    // Whichever it was, the app must still be responsive afterwards.
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
  });

  it("rejects GET /api/actuator-commands with no deviceId", async () => {
    const res = await request(app).get("/api/actuator-commands").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("rejects GET /api/actuator-commands with no bearer token", async () => {
    const res = await request(app).get(`/api/actuator-commands?deviceId=${deviceId}`);
    expect(res.status).toBe(401);
  });

  it("lists actuator commands for a device (possibly empty)", async () => {
    const res = await request(app)
      .get(`/api/actuator-commands?deviceId=${deviceId}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
