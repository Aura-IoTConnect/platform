import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { prisma } from "../src/db.js";

const TEST_EMAIL = "vitest-auth@iotplatform.local";
const TEST_PASSWORD = "vitest-password-123";

describe("auth", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: { passwordHash: await hashPassword(TEST_PASSWORD) },
      create: { email: TEST_EMAIL, passwordHash: await hashPassword(TEST_PASSWORD), role: "OPERATOR" },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  it("rejects unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@iotplatform.local", password: "whatever" });
    expect(res.status).toBe(401);
  });

  it("rejects wrong password", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: TEST_EMAIL, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects malformed body", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("issues a token for correct credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.email).toBe(TEST_EMAIL);
  });
});
