import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-alerts@iotplatform.local";

describe("/api/alerts", () => {
  let auth: { authorization: string };
  let deviceId: string;
  let otherDeviceId: string;
  let openAlertId: string;
  const alertIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    auth = { authorization: `Bearer ${signToken({ id: user.id, email: user.email, role: user.role })}` };

    const deviceType = await prisma.deviceType.findFirstOrThrow();
    const device = await prisma.device.create({ data: { deviceTypeId: deviceType.id, name: "vitest alerts device" } });
    const other = await prisma.device.create({ data: { deviceTypeId: deviceType.id, name: "vitest alerts other" } });
    deviceId = device.id;
    otherDeviceId = other.id;

    const open = await prisma.alert.create({
      data: { deviceId, severity: "WARNING", message: "open one", status: "OPEN" },
    });
    const resolved = await prisma.alert.create({
      data: { deviceId, severity: "INFO", message: "resolved one", status: "RESOLVED", resolvedAt: new Date() },
    });
    const elsewhere = await prisma.alert.create({
      data: { deviceId: otherDeviceId, severity: "INFO", message: "other device" },
    });
    openAlertId = open.id;
    alertIds.push(open.id, resolved.id, elsewhere.id);
  });

  afterAll(async () => {
    await prisma.alert.deleteMany({ where: { id: { in: alertIds } } });
    await prisma.device.deleteMany({ where: { id: { in: [deviceId, otherDeviceId] } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("requires a bearer token", async () => {
    expect((await request(app).get("/api/alerts")).status).toBe(401);
    expect((await request(app).patch(`/api/alerts/${openAlertId}`).send({ status: "RESOLVED" })).status).toBe(401);
  });

  it("filters by deviceId", async () => {
    const res = await request(app).get(`/api/alerts?deviceId=${deviceId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.map((a: { message: string }) => a.message).sort()).toEqual(["open one", "resolved one"]);
  });

  it("filters by status, and the two filters combine", async () => {
    const res = await request(app).get(`/api/alerts?deviceId=${deviceId}&status=OPEN`).set(auth);
    expect(res.body.map((a: { message: string }) => a.message)).toEqual(["open one"]);

    const resolved = await request(app).get(`/api/alerts?deviceId=${deviceId}&status=RESOLVED`).set(auth);
    expect(resolved.body.map((a: { message: string }) => a.message)).toEqual(["resolved one"]);
  });

  it("includes the device, its type/vertical and the rule for the dashboard", async () => {
    const res = await request(app).get(`/api/alerts?deviceId=${deviceId}&status=OPEN`).set(auth);
    expect(res.body[0].device.name).toBe("vitest alerts device");
    expect(res.body[0].device.deviceType.vertical.name).toBeTruthy();
    expect(res.body[0]).toHaveProperty("rule");
  });

  it("PATCH to RESOLVED stamps resolvedAt, and back to OPEN clears it", async () => {
    const resolved = await request(app).patch(`/api/alerts/${openAlertId}`).set(auth).send({ status: "RESOLVED" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("RESOLVED");
    expect(resolved.body.resolvedAt).not.toBeNull();

    const reopened = await request(app).patch(`/api/alerts/${openAlertId}`).set(auth).send({ status: "OPEN" });
    expect(reopened.body.status).toBe("OPEN");
    expect(reopened.body.resolvedAt).toBeNull();
  });

  it("PATCH to ACKNOWLEDGED leaves resolvedAt empty", async () => {
    const res = await request(app).patch(`/api/alerts/${openAlertId}`).set(auth).send({ status: "ACKNOWLEDGED" });
    expect(res.body.status).toBe("ACKNOWLEDGED");
    expect(res.body.resolvedAt).toBeNull();
  });

  it("PATCH rejects an invalid status with 400", async () => {
    const res = await request(app).patch(`/api/alerts/${openAlertId}`).set(auth).send({ status: "FIXED" });
    expect(res.status).toBe(400);
  });

  it("PATCH on an unknown alert is a 404", async () => {
    const res = await request(app).patch("/api/alerts/does-not-exist").set(auth).send({ status: "RESOLVED" });
    expect(res.status).toBe(404);
  });
});
