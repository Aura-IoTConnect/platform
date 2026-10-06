import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-telemetry@iotplatform.local";

describe("GET /api/telemetry", () => {
  let token: string;
  let deviceId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });

    const deviceType = await prisma.deviceType.findFirstOrThrow();
    const device = await prisma.device.create({
      data: { deviceTypeId: deviceType.id, name: "vitest telemetry device" },
    });
    deviceId = device.id;

    // Three readings, oldest first, one hour apart.
    const base = Date.now() - 3 * 3600_000;
    for (let i = 0; i < 3; i++) {
      await prisma.telemetryReading.create({
        data: { deviceId, metric: "temperature", value: i, timestamp: new Date(base + i * 3600_000) },
      });
    }
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { id: deviceId } }); // cascades to readings
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  const get = (path: string) => request(app).get(path).set("authorization", `Bearer ${token}`);

  it("requires a bearer token", async () => {
    expect((await request(app).get(`/api/telemetry?deviceId=${deviceId}`)).status).toBe(401);
  });

  it("requires a deviceId", async () => {
    const res = await get("/api/telemetry");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deviceId/);
  });

  it("returns readings newest-first", async () => {
    const res = await get(`/api/telemetry?deviceId=${deviceId}`);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { value: number }) => r.value)).toEqual([2, 1, 0]);
  });

  it("honours limit", async () => {
    const res = await get(`/api/telemetry?deviceId=${deviceId}&limit=2`);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].value).toBe(2); // still the newest ones
  });

  it("falls back to the default limit for a garbage value instead of erroring", async () => {
    const res = await get(`/api/telemetry?deviceId=${deviceId}&limit=abc`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it("returns an empty list for a device with no readings (or an unknown id)", async () => {
    const res = await get("/api/telemetry?deviceId=does-not-exist");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
