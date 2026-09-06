import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-devices@iotplatform.local";

describe("protected routes", () => {
  let token: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("rejects requests with no bearer token", async () => {
    const res = await request(app).get("/api/devices");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a garbage token", async () => {
    const res = await request(app).get("/api/devices").set("authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("allows requests with a valid token", async () => {
    const res = await request(app).get("/api/devices").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("lists seeded verticals", async () => {
    const res = await request(app).get("/api/verticals").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.map((v: { key: string }) => v.key)).toContain("cold-storage");
  });
});

describe("device api keys", () => {
  let token: string;
  let deviceTypeId: string;
  let createdDeviceId: string;

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
    if (createdDeviceId) {
      await prisma.device.delete({ where: { id: createdDeviceId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it("returns a one-time apiKey on create, never the hash", async () => {
    const res = await request(app)
      .post("/api/devices")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest device", deviceTypeId });

    expect(res.status).toBe(201);
    expect(typeof res.body.apiKey).toBe("string");
    expect(res.body.apiKey.length).toBeGreaterThan(0);
    expect(res.body.apiKeyHash).toBeUndefined();
    createdDeviceId = res.body.id;
  });

  it("creates the device even when MQTT provisioning fails (workers unreachable in CI)", async () => {
    // Regression coverage for the same "workers is optional" contract as
    // actuator.test.ts: MQTT credential provisioning is best-effort, layered
    // on top of the apiKeyHash that's already the source of truth, so it
    // must never block device creation. CI doesn't run apps/workers, so this
    // exercises exactly that degraded path.
    const res = await request(app)
      .post("/api/devices")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest device (mqtt check)", deviceTypeId });

    expect(res.status).toBe(201);
    expect(typeof res.body.mqttProvisioned).toBe("boolean");
    await prisma.device.delete({ where: { id: res.body.id } }).catch(() => {});
  });

  it("omits apiKeyHash from list and detail responses", async () => {
    const list = await request(app).get("/api/devices").set("authorization", `Bearer ${token}`);
    expect(list.body.every((d: Record<string, unknown>) => !("apiKeyHash" in d))).toBe(true);

    const detail = await request(app)
      .get(`/api/devices/${createdDeviceId}`)
      .set("authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.apiKeyHash).toBeUndefined();
  });

  it("rotate-key returns a new one-time apiKey", async () => {
    const first = await request(app)
      .post(`/api/devices/${createdDeviceId}/rotate-key`)
      .set("authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(typeof first.body.apiKey).toBe("string");
    expect(typeof first.body.mqttProvisioned).toBe("boolean");

    const second = await request(app)
      .post(`/api/devices/${createdDeviceId}/rotate-key`)
      .set("authorization", `Bearer ${token}`);
    expect(second.body.apiKey).not.toBe(first.body.apiKey);
  });

  it("rotate-key 404s for an unknown device", async () => {
    const res = await request(app)
      .post("/api/devices/does-not-exist/rotate-key")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
