import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-device-lifecycle@iotplatform.local";

describe("device lifecycle metadata + service log", () => {
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
      .send({ name: "vitest lifecycle device", deviceTypeId });
    deviceId = created.body.id;
  });

  afterAll(async () => {
    await prisma.device.delete({ where: { id: deviceId } }).catch(() => {});
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("PATCH requires a bearer token", async () => {
    const res = await request(app).patch(`/api/devices/${deviceId}`).send({ firmwareVersion: "1.0.0" });
    expect(res.status).toBe(401);
  });

  it("PATCH updates lifecycle fields and returns the nested deviceType without leaking provisionSecretHash", async () => {
    const commissionedAt = "2026-01-15T00:00:00.000Z";
    const warrantyExpiresAt = "2028-01-15T00:00:00.000Z";
    const res = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("authorization", `Bearer ${token}`)
      .send({
        firmwareVersion: "2.1.0",
        hardwareModel: "Rev-C",
        manufacturer: "Acme Sensors",
        commissionedAt,
        warrantyExpiresAt,
      });

    expect(res.status).toBe(200);
    expect(res.body.firmwareVersion).toBe("2.1.0");
    expect(res.body.hardwareModel).toBe("Rev-C");
    expect(res.body.manufacturer).toBe("Acme Sensors");
    expect(new Date(res.body.commissionedAt).toISOString()).toBe(commissionedAt);
    expect(new Date(res.body.warrantyExpiresAt).toISOString()).toBe(warrantyExpiresAt);
    expect(res.body.deviceType.provisionSecretHash).toBeUndefined();
    expect(res.body.apiKeyHash).toBeUndefined();
  });

  it("PATCH accepts a partial update without clobbering other fields", async () => {
    const res = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ hardwareModel: "Rev-D" });
    expect(res.status).toBe(200);
    expect(res.body.hardwareModel).toBe("Rev-D");
    expect(res.body.manufacturer).toBe("Acme Sensors"); // untouched by this call
  });

  it("PATCH 404s for an unknown device", async () => {
    const res = await request(app)
      .patch("/api/devices/does-not-exist")
      .set("authorization", `Bearer ${token}`)
      .send({ firmwareVersion: "1.0.0" });
    expect(res.status).toBe(404);
  });

  it("service log requires a bearer token", async () => {
    expect((await request(app).get(`/api/devices/${deviceId}/service-log`)).status).toBe(401);
    expect((await request(app).post(`/api/devices/${deviceId}/service-log`).send({ note: "x" })).status).toBe(401);
  });

  it("service log 404s for an unknown device on both GET and POST", async () => {
    expect(
      (await request(app).get("/api/devices/does-not-exist/service-log").set("authorization", `Bearer ${token}`))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/api/devices/does-not-exist/service-log")
          .set("authorization", `Bearer ${token}`)
          .send({ note: "x" })
      ).status,
    ).toBe(404);
  });

  it("service log rejects an empty note", async () => {
    const res = await request(app)
      .post(`/api/devices/${deviceId}/service-log`)
      .set("authorization", `Bearer ${token}`)
      .send({ note: "" });
    expect(res.status).toBe(400);
  });

  it("adds and lists service log entries newest-first, stamped with the caller's email", async () => {
    const first = await request(app)
      .post(`/api/devices/${deviceId}/service-log`)
      .set("authorization", `Bearer ${token}`)
      .send({ note: "Replaced desiccant pack" });
    expect(first.status).toBe(201);
    expect(first.body.createdBy).toBe(TEST_EMAIL);

    const second = await request(app)
      .post(`/api/devices/${deviceId}/service-log`)
      .set("authorization", `Bearer ${token}`)
      .send({ note: "Recalibrated sensor" });
    expect(second.status).toBe(201);

    const list = await request(app).get(`/api/devices/${deviceId}/service-log`).set("authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].note).toBe("Recalibrated sensor"); // newest first
    expect(list.body[1].note).toBe("Replaced desiccant pack");
  });
});
