import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-device-gateway@iotplatform.local";

describe("gateway -> child device hierarchy", () => {
  let token: string;
  let deviceTypeId: string;
  let gatewayId: string;
  let childId: string;
  let otherId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
    deviceTypeId = (await prisma.deviceType.findFirstOrThrow()).id;

    const create = (name: string) =>
      request(app)
        .post("/api/devices")
        .set("authorization", `Bearer ${token}`)
        .send({ name, deviceTypeId })
        .then((res) => res.body.id as string);
    gatewayId = await create("vitest gateway");
    childId = await create("vitest child");
    otherId = await create("vitest other");
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { id: { in: [gatewayId, childId, otherId] } } });
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("PATCH attaches a child device to a parent and returns childDevices on the parent", async () => {
    const res = await request(app)
      .patch(`/api/devices/${childId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: gatewayId });
    expect(res.status).toBe(200);
    expect(res.body.parentDeviceId).toBe(gatewayId);

    const parent = await request(app).get(`/api/devices/${gatewayId}`).set("authorization", `Bearer ${token}`);
    expect(parent.body.childDevices).toHaveLength(1);
    expect(parent.body.childDevices[0].id).toBe(childId);
  });

  it("rejects a device becoming its own parent", async () => {
    const res = await request(app)
      .patch(`/api/devices/${gatewayId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: gatewayId });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown parentDeviceId", async () => {
    const res = await request(app)
      .patch(`/api/devices/${otherId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: "does-not-exist" });
    expect(res.status).toBe(400);
  });

  it("rejects attaching under a device that is itself already a child (one level only)", async () => {
    const res = await request(app)
      .patch(`/api/devices/${otherId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: childId }); // childId already has gatewayId as its parent
    expect(res.status).toBe(400);
  });

  it("rejects a gateway with children becoming a child itself", async () => {
    const res = await request(app)
      .patch(`/api/devices/${gatewayId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: otherId });
    expect(res.status).toBe(400);
  });

  it("detaches a child by setting parentDeviceId to null", async () => {
    const res = await request(app)
      .patch(`/api/devices/${childId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: null });
    expect(res.status).toBe(200);
    expect(res.body.parentDeviceId).toBeNull();

    const parent = await request(app).get(`/api/devices/${gatewayId}`).set("authorization", `Bearer ${token}`);
    expect(parent.body.childDevices).toHaveLength(0);
  });

  it("GET /api/devices list includes childDevices for each device", async () => {
    await request(app)
      .patch(`/api/devices/${childId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentDeviceId: gatewayId });

    const res = await request(app).get("/api/devices").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const gateway = res.body.find((d: { id: string }) => d.id === gatewayId);
    expect(gateway.childDevices).toHaveLength(1);
    expect(gateway.childDevices[0].id).toBe(childId);
  });
});
