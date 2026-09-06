import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

describe("GET /metrics", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is reachable without a bearer token, in Prometheus text format", async () => {
    // Warm the request histogram with one routed request first.
    await request(app).get("/health");

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("# TYPE http_requests_total counter");
    expect(res.text).toContain("http_request_duration_seconds_bucket");
    expect(res.text).toMatch(/http_requests_total\{method="GET",route="\/health",status_code="200"\}/);
    // Default process metrics from collectDefaultMetrics()
    expect(res.text).toContain("nodejs_eventloop_lag_seconds");
  });
});
