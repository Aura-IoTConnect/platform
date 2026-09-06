import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-device-types@iotplatform.local";

describe("device type provisioning", () => {
  let token: string;
  let deviceTypeId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });

    const deviceType = await prisma.deviceType.findFirstOrThrow();
    deviceTypeId = deviceType.id;
  });

  afterAll(async () => {
    // Clear any provisioning credential this suite generated so it doesn't
    // linger on shared seed data between runs.
    await prisma.deviceType
      .update({ where: { id: deviceTypeId }, data: { provisionKey: null, provisionSecretHash: null } })
      .catch(() => {});
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("omits provisionSecretHash from list and detail responses", async () => {
    const list = await request(app).get("/api/device-types").set("authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.every((dt: Record<string, unknown>) => !("provisionSecretHash" in dt))).toBe(true);

    const detail = await request(app)
      .get(`/api/device-types/${deviceTypeId}`)
      .set("authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.provisionSecretHash).toBeUndefined();
  });

  it("rejects generating a provisioning secret with no bearer token", async () => {
    const res = await request(app).post(`/api/device-types/${deviceTypeId}/provisioning-secret`);
    expect(res.status).toBe(401);
  });

  it("generates a one-time provisionKey + provisionSecret", async () => {
    const res = await request(app)
      .post(`/api/device-types/${deviceTypeId}/provisioning-secret`)
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.provisionKey).toBe("string");
    expect(typeof res.body.provisionSecret).toBe("string");
    expect(res.body.provisionKey.length).toBeGreaterThan(0);
    expect(res.body.provisionSecret.length).toBeGreaterThan(0);

    const updated = await prisma.deviceType.findUniqueOrThrow({ where: { id: deviceTypeId } });
    expect(updated.provisionKey).toBe(res.body.provisionKey);
    expect(updated.provisionSecretHash).not.toBeNull();
    // The raw secret is never persisted, only its hash.
    expect(updated.provisionSecretHash).not.toBe(res.body.provisionSecret);
  });

  it("rotating invalidates the previous provisionKey/provisionSecret pair", async () => {
    const first = await request(app)
      .post(`/api/device-types/${deviceTypeId}/provisioning-secret`)
      .set("authorization", `Bearer ${token}`);

    const second = await request(app)
      .post(`/api/device-types/${deviceTypeId}/provisioning-secret`)
      .set("authorization", `Bearer ${token}`);

    expect(second.body.provisionKey).not.toBe(first.body.provisionKey);
    expect(second.body.provisionSecret).not.toBe(first.body.provisionSecret);
  });

  it("404s for an unknown device type", async () => {
    const res = await request(app)
      .post("/api/device-types/does-not-exist/provisioning-secret")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/device-types/:id/actuator (bulk dispatch)", () => {
  let token: string;
  let deviceTypeId: string;
  let deviceCount: number;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: "vitest-bulk-actuator@iotplatform.local" },
      update: {},
      create: {
        email: "vitest-bulk-actuator@iotplatform.local",
        passwordHash: await hashPassword("irrelevant"),
        role: "OPERATOR",
      },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
    const device = await prisma.device.findFirstOrThrow();
    deviceTypeId = device.deviceTypeId;
    deviceCount = await prisma.device.count({ where: { deviceTypeId } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { email: "vitest-bulk-actuator@iotplatform.local" } });
    await prisma.$disconnect();
  });

  it("requires a bearer token", async () => {
    const res = await request(app).post(`/api/device-types/${deviceTypeId}/actuator`).send({ command: "x" });
    expect(res.status).toBe(401);
  });

  it("validates the body", async () => {
    const res = await request(app)
      .post(`/api/device-types/${deviceTypeId}/actuator`)
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("404s for an unknown device type", async () => {
    const res = await request(app)
      .post("/api/device-types/does-not-exist/actuator")
      .set("authorization", `Bearer ${token}`)
      .send({ command: "x" });
    expect(res.status).toBe(404);
  });

  it("returns one result per device of the type, and never fails the whole call on a per-device error", async () => {
    // CI doesn't run apps/workers, so every per-device dispatch 502s there —
    // the response must still be a 200 with the failures itemised.
    const res = await request(app)
      .post(`/api/device-types/${deviceTypeId}/actuator`)
      .set("authorization", `Bearer ${token}`)
      .send({ command: "vitest_bulk" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(deviceCount);
    expect(res.body.dispatched + res.body.failed).toBe(deviceCount);
    for (const r of res.body.results) expect(typeof r.ok).toBe("boolean");
  });
});
