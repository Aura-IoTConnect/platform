import type { NextFunction, Request, Response } from "express";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

/**
 * Platform-level observability for apps/api itself — request latency,
 * error rates, event-loop lag — as opposed to Alert/TelemetryReading, which
 * model the *industrial process* being monitored, not this service. Exposed
 * in Prometheus text format at GET /metrics (see app.ts); nothing scrapes it
 * yet, it's useful the moment it exists (curl it). See CLAUDE.md.
 *
 * Label sets are deliberately tiny and fixed (method / route template /
 * status) — a Prometheus series exists per unique label combination, so
 * device/rule/alert/user ids must never become labels.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "HTTP requests handled by apps/api",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency for apps/api",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    // req.route is the matched Express route template (":id" not the
    // actual id), which is what keeps the label bounded. Requests that
    // never matched a route (404s) are bucketed as "unmatched".
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    end(labels);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader("content-type", registry.contentType);
  res.send(await registry.metrics());
}
