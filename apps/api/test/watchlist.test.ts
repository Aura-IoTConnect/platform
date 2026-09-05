import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword, signToken } from "../src/auth.js";
import { prisma } from "../src/db.js";

const EMAIL_A = "vitest-watchlist-a@iotplatform.local";
const EMAIL_B = "vitest-watchlist-b@iotplatform.local";

async function userToken(email: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await hashPassword("irrelevant"), role: "OPERATOR" },
  });
  return { id: user.id, token: signToken({ id: user.id, email: user.email, role: user.role }) };
}

describe("/api/watchlist", () => {
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let deviceId: string;
  let metricKey: string;

  beforeAll(async () => {
    a = await userToken(EMAIL_A);
    b = await userToken(EMAIL_B);
    const device = await prisma.device.findFirstOrThrow({ include: { deviceType: true } });
    deviceId = device.id;
    metricKey = (device.deviceType.metrics as { key: string }[])[0].key;
  });

  afterAll(async () => {
    await prisma.watchlistItem.deleteMany({ where: { userId: { in: [a.id, b.id] } } });
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
    await prisma.$disconnect();
  });

  it("requires a bearer token", async () => {
    expect((await request(app).get("/api/watchlist")).status).toBe(401);
  });

  it("rejects a metric the device's type doesn't declare", async () => {
    const res = await request(app)
      .post("/api/watchlist")
      .set("authorization", `Bearer ${a.token}`)
      .send({ deviceId, metricKey: "not_a_real_metric" });
    expect(res.status).toBe(400);
  });

  it("pins, lists per-user, refuses duplicates, and unpins", async () => {
    const created = await request(app)
      .post("/api/watchlist")
      .set("authorization", `Bearer ${a.token}`)
      .send({ deviceId, metricKey });
    expect(created.status).toBe(201);
    expect(created.body.device.deviceType).toBeDefined();

    const dup = await request(app)
      .post("/api/watchlist")
      .set("authorization", `Bearer ${a.token}`)
      .send({ deviceId, metricKey });
    expect(dup.status).toBe(409);

    const listA = await request(app).get("/api/watchlist").set("authorization", `Bearer ${a.token}`);
    expect(listA.body.map((i: { id: string }) => i.id)).toContain(created.body.id);

    // Scoped to the caller — user B can't see or delete A's item.
    const listB = await request(app).get("/api/watchlist").set("authorization", `Bearer ${b.token}`);
    expect(listB.body).toHaveLength(0);
    const crossDelete = await request(app)
      .delete(`/api/watchlist/${created.body.id}`)
      .set("authorization", `Bearer ${b.token}`);
    expect(crossDelete.status).toBe(404);

    const del = await request(app).delete(`/api/watchlist/${created.body.id}`).set("authorization", `Bearer ${a.token}`);
    expect(del.status).toBe(204);
    const after = await request(app).get("/api/watchlist").set("authorization", `Bearer ${a.token}`);
    expect(after.body).toHaveLength(0);
  });
});
