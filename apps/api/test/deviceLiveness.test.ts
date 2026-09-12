import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-device-liveness@iotplatform.local";

// apps/workers owns writing Device.lastSeenAt (telemetry ingestion or POST
// /ingestion/heartbeat — see CLAUDE.md's "Liveness signal & Devices tab
// search" section). apps/api only ever reads it back; these tests cover
// that read-only boundary from this side (apps/workers' own coverage is in
// apps/workers/tests/test_telemetry_service.py).
describe("device liveness (lastSeenAt)", () => {
  let token: string;
  let deviceTypeId: string;
  let deviceId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
    deviceTypeId = (await prisma.deviceType.findFirstOrThrow()).id;

    const created = await request(app)
      .post("/api/devices")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest liveness device", deviceTypeId });
    deviceId = created.body.id;
  });

  afterAll(async () => {
    await prisma.device.delete({ where: { id: deviceId } }).catch(() => {});
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("a freshly created device has never reported", async () => {
    const res = await request(app).get(`/api/devices/${deviceId}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.lastSeenAt).toBeNull();
  });

  it("PATCH silently ignores an attempt to set lastSeenAt directly", async () => {
    const res = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ lastSeenAt: new Date().toISOString(), name: "vitest liveness device (renamed)" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("vitest liveness device (renamed)");
    expect(res.body.lastSeenAt).toBeNull();
  });

  it("reflects a lastSeenAt stamped directly in Postgres (simulating apps/workers)", async () => {
    const stampedAt = new Date();
    await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: stampedAt } });

    const res = await request(app).get(`/api/devices/${deviceId}`).set("authorization", `Bearer ${token}`);
    expect(new Date(res.body.lastSeenAt).toISOString()).toBe(stampedAt.toISOString());
  });
});
