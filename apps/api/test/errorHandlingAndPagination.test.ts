import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-error-pagination@iotplatform.local";

describe("global error handling", () => {
  let token: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("turns a rejected DB call in a list route into a generic 500, without leaking the cause", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.site, "findMany").mockRejectedValueOnce(new Error("connection refused: secret-db-host"));

    const res = await request(app).get("/api/sites").set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toContain("secret-db-host");
    expect(console.error).toHaveBeenCalled(); // the real error is logged server-side
  });

  it("the process keeps serving requests after a failed one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Fail one model's delegate, then hit a route backed by a different,
    // untouched one: a spy on Prisma's proxied delegates doesn't fall back to
    // the real query faithfully, so reusing the spied delegate would test the
    // mock rather than the server.
    vi.spyOn(prisma.deviceType, "findMany").mockRejectedValueOnce(new Error("boom"));
    const failed = await request(app).get("/api/device-types").set("authorization", `Bearer ${token}`);
    expect(failed.status).toBe(500);

    const res = await request(app).get("/api/verticals").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("answers a malformed JSON body with 400, not 500", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("content-type", "application/json")
      .send('{"email": "broken');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Malformed JSON body" });
  });

  it("a PATCH on an unknown record is still a 404 (not-found is distinguished from a real failure)", async () => {
    const res = await request(app)
      .patch("/api/alerts/does-not-exist")
      .set("authorization", `Bearer ${token}`)
      .send({ status: "RESOLVED" });
    expect(res.status).toBe(404);
  });

  it("a DB failure during a PATCH surfaces as 500, not a misleading 404", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.alert, "update").mockRejectedValueOnce(new Error("deadlock detected"));

    const res = await request(app)
      .patch("/api/alerts/anything")
      .set("authorization", `Bearer ${token}`)
      .send({ status: "RESOLVED" });
    expect(res.status).toBe(500);
  });
});

describe("pagination on GET /api/devices and /api/alerts", () => {
  let token: string;
  let deviceId: string;
  let deviceTypeId: string;
  const alertIds: string[] = [];
  const deviceIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    token = signToken({ id: user.id, email: user.email, role: user.role });
    deviceTypeId = (await prisma.deviceType.findFirstOrThrow()).id;

    for (let i = 0; i < 3; i++) {
      const device = await prisma.device.create({
        data: { deviceTypeId, name: `vitest page device ${i}`, tags: ["vitest-page"] },
      });
      deviceIds.push(device.id);
    }
    deviceId = deviceIds[0];
    for (let i = 0; i < 3; i++) {
      const alert = await prisma.alert.create({
        data: { deviceId, severity: "INFO", message: `vitest page alert ${i}` },
      });
      alertIds.push(alert.id);
    }
  });

  afterAll(async () => {
    await prisma.alert.deleteMany({ where: { id: { in: alertIds } } });
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  const get = (path: string) => request(app).get(path).set("authorization", `Bearer ${token}`);

  it("devices: limit/offset page the result and X-Total-Count reports the unpaginated total", async () => {
    const first = await get("/api/devices?tag=vitest-page&limit=2");
    expect(first.body).toHaveLength(2);
    expect(first.headers["x-total-count"]).toBe("3");

    const rest = await get("/api/devices?tag=vitest-page&limit=2&offset=2");
    expect(rest.body).toHaveLength(1);
    expect(rest.headers["x-total-count"]).toBe("3");

    const ids = [...first.body, ...rest.body].map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(3); // no overlap between pages
  });

  it("alerts: same contract", async () => {
    const first = await get(`/api/alerts?deviceId=${deviceId}&limit=2`);
    expect(first.body).toHaveLength(2);
    expect(first.headers["x-total-count"]).toBe("3");

    const rest = await get(`/api/alerts?deviceId=${deviceId}&limit=2&offset=2`);
    expect(rest.body).toHaveLength(1);
  });

  it("garbage limit/offset fall back to defaults instead of erroring", async () => {
    const res = await get("/api/devices?tag=vitest-page&limit=abc&offset=-5");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it("limit is capped at the max", async () => {
    const res = await get("/api/devices?tag=vitest-page&limit=99999999");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1000);
  });
});
