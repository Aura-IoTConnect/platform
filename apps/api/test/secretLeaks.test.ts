import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-secret-leaks@iotplatform.local";
const SECRET_KEYS = ["apiKeyHash", "provisionSecretHash"];

// Walks the whole response body — secrets nest several levels deep
// (alert -> device -> deviceType, watchlist item -> device -> deviceType,
// vertical -> deviceTypes[]), so a top-level check would miss exactly the
// leaks this guards against.
function findSecretPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecretPaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      SECRET_KEYS.includes(k) ? [`${path}.${k}`] : findSecretPaths(v, `${path}.${k}`),
    );
  }
  return [];
}

describe("credential fingerprints never reach the client", () => {
  let token: string;
  let userId: string;
  let verticalId: string;
  let deviceTypeId: string;
  let deviceId: string;
  let ruleId: string;
  let alertId: string;

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: {},
      create: { email: TEST_EMAIL, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
    });
    userId = user.id;
    token = signToken({ id: user.id, email: user.email, role: user.role });

    // A device + type that genuinely hold both secret fingerprints, so a
    // leak would be visible rather than a null that happens to serialize.
    const vertical = await prisma.vertical.create({
      data: { key: `vitest-leak-${Date.now()}`, name: "vitest leak vertical", description: "test" },
    });
    verticalId = vertical.id;
    const deviceType = await prisma.deviceType.create({
      data: {
        verticalId,
        key: "vitest-leak-type",
        name: "vitest leak type",
        description: "test",
        metrics: [{ key: "temp", label: "Temp", unit: "C" }],
        provisionKey: `vitest-leak-pk-${Date.now()}`,
        provisionSecretHash: "SECRET-PROVISION-FINGERPRINT",
      },
    });
    deviceTypeId = deviceType.id;
    const device = await prisma.device.create({
      data: {
        deviceTypeId,
        name: "vitest leak device",
        apiKeyHash: `SECRET-APIKEY-FINGERPRINT-${Date.now()}`,
        tags: ["vitest-leak"],
      },
    });
    deviceId = device.id;
    const rule = await prisma.rule.create({
      data: { deviceTypeId, name: "vitest leak rule", metric: "temp", operator: "GT", threshold: 1, actionType: "notify" },
    });
    ruleId = rule.id;
    const alert = await prisma.alert.create({
      data: { deviceId, ruleId, severity: "INFO", message: "vitest leak alert" },
    });
    alertId = alert.id;
  });

  afterAll(async () => {
    await prisma.watchlistItem.deleteMany({ where: { userId } });
    await prisma.alert.deleteMany({ where: { id: alertId } });
    await prisma.rule.deleteMany({ where: { id: ruleId } });
    await prisma.device.deleteMany({ where: { id: deviceId } });
    await prisma.deviceType.deleteMany({ where: { id: deviceTypeId } });
    await prisma.vertical.deleteMany({ where: { id: verticalId } });
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  const get = (path: string) => request(app).get(path).set("authorization", `Bearer ${token}`);

  it("the fixtures really do hold secrets (guards against a vacuous pass)", async () => {
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    const deviceType = await prisma.deviceType.findUniqueOrThrow({ where: { id: deviceTypeId } });
    expect(device.apiKeyHash).toContain("SECRET");
    expect(deviceType.provisionSecretHash).toContain("SECRET");
  });

  it("GET /api/alerts", async () => {
    const res = await get(`/api/alerts?deviceId=${deviceId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].device.deviceType.name).toBe("vitest leak type"); // nested data still present
    expect(findSecretPaths(res.body)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it("GET /api/rules", async () => {
    const res = await get(`/api/rules?deviceTypeId=${deviceTypeId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(findSecretPaths(res.body)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it("GET /api/verticals and /api/verticals/:id", async () => {
    const list = await get("/api/verticals");
    expect(list.status).toBe(200);
    expect(findSecretPaths(list.body)).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain("SECRET");

    const one = await get(`/api/verticals/${verticalId}`);
    expect(one.status).toBe(200);
    expect(one.body.deviceTypes).toHaveLength(1);
    expect(findSecretPaths(one.body)).toEqual([]);
  });

  it("GET /api/device-types and /api/devices", async () => {
    const types = await get(`/api/device-types?verticalId=${verticalId}`);
    expect(findSecretPaths(types.body)).toEqual([]);

    const devices = await get("/api/devices?tag=vitest-leak");
    expect(devices.body).toHaveLength(1);
    expect(findSecretPaths(devices.body)).toEqual([]);

    const one = await get(`/api/devices/${deviceId}`);
    expect(findSecretPaths(one.body)).toEqual([]);
  });

  it("POST + GET /api/watchlist", async () => {
    const created = await request(app)
      .post("/api/watchlist")
      .set("authorization", `Bearer ${token}`)
      .send({ deviceId, metricKey: "temp" });
    expect(created.status).toBe(201);
    expect(findSecretPaths(created.body)).toEqual([]);

    const list = await get("/api/watchlist");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].device.name).toBe("vitest leak device"); // nested data still present
    expect(findSecretPaths(list.body)).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain("SECRET");
  });
});
