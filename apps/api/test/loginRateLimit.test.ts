import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { hashPassword } from "../src/auth.js";
import { prisma } from "../src/db.js";
import { LoginLimiter } from "../src/loginLimiter.js";

const TEST_EMAIL = "vitest-login-limit@iotplatform.local";
const TEST_PASSWORD = "vitest-password-123";

describe("LoginLimiter", () => {
  it("blocks a key only after maxFailures failures, and reports a Retry-After", () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter(3, 60_000, () => now);

    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.retryAfterSeconds("ip")).toBe(0);

    limiter.recordFailure("ip");
    expect(limiter.retryAfterSeconds("ip")).toBe(60);

    now += 30_000;
    expect(limiter.retryAfterSeconds("ip")).toBe(30);
  });

  it("unblocks once the window expires", () => {
    let now = 0;
    const limiter = new LoginLimiter(1, 1000, () => now);
    limiter.recordFailure("ip");
    expect(limiter.retryAfterSeconds("ip")).toBeGreaterThan(0);

    now = 1001;
    expect(limiter.retryAfterSeconds("ip")).toBe(0);
  });

  it("tracks keys independently and reset() clears one", () => {
    const limiter = new LoginLimiter(1, 60_000);
    limiter.recordFailure("a");
    expect(limiter.retryAfterSeconds("a")).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds("b")).toBe(0);

    limiter.reset("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
  });
});

describe("POST /api/auth/login brute-force guard", () => {
  let app: typeof import("../src/app.js").app;

  beforeAll(async () => {
    // The route reads these once at import time, so set them before importing.
    process.env.LOGIN_MAX_FAILURES = "3";
    process.env.LOGIN_WINDOW_MS = "60000";
    ({ app } = await import("../src/app.js"));

    await prisma.user.upsert({
      where: { email: TEST_EMAIL },
      update: { passwordHash: await hashPassword(TEST_PASSWORD) },
      create: { email: TEST_EMAIL, passwordHash: await hashPassword(TEST_PASSWORD), role: "OPERATOR" },
    });
  });

  afterAll(async () => {
    delete process.env.LOGIN_MAX_FAILURES;
    delete process.env.LOGIN_WINDOW_MS;
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.$disconnect();
  });

  const login = (password: string) => request(app).post("/api/auth/login").send({ email: TEST_EMAIL, password });

  it("a successful login resets the failure count", async () => {
    expect((await login("wrong")).status).toBe(401);
    expect((await login("wrong")).status).toBe(401);
    expect((await login(TEST_PASSWORD)).status).toBe(200); // 2 failures, then success -> counter cleared

    // Two more failures would have crossed the threshold had the count not reset.
    expect((await login("wrong")).status).toBe(401);
    expect((await login("wrong")).status).toBe(401);
    expect((await login(TEST_PASSWORD)).status).toBe(200);
  });

  it("locks out after repeated failures — even the correct password is refused while locked", async () => {
    expect((await login("wrong")).status).toBe(401);
    expect((await login("wrong")).status).toBe(401);
    expect((await login("wrong")).status).toBe(401);

    const blocked = await login("wrong");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const correctButLocked = await login(TEST_PASSWORD);
    expect(correctButLocked.status).toBe(429);
  });
});
