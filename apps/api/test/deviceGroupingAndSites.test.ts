import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-device-grouping@iotplatform.local";

describe("sites", () => {
  let token: string;
  let siteIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
  });

  afterAll(async () => {
    await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("creates a site and a nested child site", async () => {
    const parent = await request(app)
      .post("/api/sites")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest Region" });
    expect(parent.status).toBe(201);
    siteIds.push(parent.body.id);

    const child = await request(app)
      .post("/api/sites")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest Facility", parentSiteId: parent.body.id });
    expect(child.status).toBe(201);
    expect(child.body.parentSiteId).toBe(parent.body.id);
    siteIds.push(child.body.id);
  });

  it("rejects an unknown parentSiteId", async () => {
    const res = await request(app)
      .post("/api/sites")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "orphan", parentSiteId: "does-not-exist" });
    expect(res.status).toBe(400);
  });

  it("rejects a PATCH that would create a cycle", async () => {
    const [parentId, childId] = siteIds;
    const res = await request(app)
      .patch(`/api/sites/${parentId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ parentSiteId: childId });
    expect(res.status).toBe(400);
  });

  it("refuses to delete a site with a child site attached", async () => {
    const [parentId] = siteIds;
    const res = await request(app).delete(`/api/sites/${parentId}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("deletes a leaf site with nothing attached", async () => {
    const [, childId] = siteIds;
    const res = await request(app).delete(`/api/sites/${childId}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    siteIds = siteIds.filter((id) => id !== childId);
  });
});

describe("device tags and site assignment", () => {
  let token: string;
  let deviceTypeId: string;
  let deviceId: string;
  let siteId: string;

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
      .send({ name: "vitest grouping device", deviceTypeId });
    deviceId = created.body.id;

    const site = await request(app)
      .post("/api/sites")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest grouping site" });
    siteId = site.body.id;
  });

  afterAll(async () => {
    await prisma.device.delete({ where: { id: deviceId } }).catch(() => {});
    await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("PATCH sets tags (replacing the whole array) and siteId", async () => {
    const res = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ tags: ["freezer", "critical"], siteId });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(["freezer", "critical"]);
    expect(res.body.site.id).toBe(siteId);

    const replaced = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ tags: ["freezer"] });
    expect(replaced.body.tags).toEqual(["freezer"]);
  });

  it("rejects an unknown siteId", async () => {
    const res = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ siteId: "does-not-exist" });
    expect(res.status).toBe(400);
  });

  it("GET /api/devices?tag= filters to devices carrying that tag", async () => {
    const res = await request(app).get("/api/devices?tag=freezer").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((d: { id: string }) => d.id === deviceId)).toBe(true);

    const none = await request(app).get("/api/devices?tag=not-a-real-tag").set("authorization", `Bearer ${token}`);
    expect(none.body.some((d: { id: string }) => d.id === deviceId)).toBe(false);
  });
});

describe("device CSV export/import", () => {
  let token: string;
  let deviceTypeId: string;
  let verticalKey: string;
  let deviceTypeKey: string;
  let importedIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
    const deviceType = await prisma.deviceType.findFirstOrThrow({ include: { vertical: true } });
    deviceTypeId = deviceType.id;
    verticalKey = deviceType.vertical.key;
    deviceTypeKey = deviceType.key;
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { id: { in: importedIds } } });
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("GET /api/devices/export returns a CSV with a header row and one row per device", async () => {
    const created = await request(app)
      .post("/api/devices")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "vitest export device", deviceTypeId });
    importedIds.push(created.body.id);

    const res = await request(app).get("/api/devices/export").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "name,verticalKey,deviceTypeKey,location,tags,site,status,firmwareVersion,hardwareModel,manufacturer,commissionedAt,warrantyExpiresAt",
    );
    expect(lines.some((l) => l.startsWith("vitest export device,"))).toBe(true);
  });

  it("POST /api/devices/import creates devices from valid rows and reports failures for bad ones", async () => {
    const csv = [
      "name,verticalKey,deviceTypeKey,tags",
      `vitest import ok,${verticalKey},${deviceTypeKey},alpha;beta`,
      "vitest import bad type,does-not-exist,does-not-exist,",
    ].join("\n");

    const res = await request(app)
      .post("/api/devices/import")
      .set("authorization", `Bearer ${token}`)
      .send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[1].ok).toBe(false);

    importedIds.push(res.body.results[0].deviceId);
    const device = await prisma.device.findUniqueOrThrow({ where: { id: res.body.results[0].deviceId } });
    expect(device.tags).toEqual(["alpha", "beta"]);
  });

  it("rejects a CSV missing required columns", async () => {
    const res = await request(app)
      .post("/api/devices/import")
      .set("authorization", `Bearer ${token}`)
      .send({ csv: "name,location\nsomething,somewhere" });
    expect(res.status).toBe(400);
  });
});
