// In-memory brute-force guard for POST /api/auth/login. Counts only *failed*
// attempts per client key (IP) in a fixed window, so a legitimate user who
// logs in successfully is never throttled and a success clears the counter.
//
// Deliberately process-local: this is a single-instance dashboard API, and a
// shared store (Redis) would be disproportionate. Behind a reverse proxy,
// set `app.set("trust proxy", ...)` so req.ip is the real client, not the
// proxy. Tunable via LOGIN_MAX_FAILURES / LOGIN_WINDOW_MS.

export class LoginLimiter {
  private entries = new Map<string, { failures: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // Seconds until the key may try again, or 0 if it isn't blocked.
  retryAfterSeconds(key: string): number {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry || entry.failures < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { failures: 1, resetAt: now + this.windowMs });
    } else {
      entry.failures += 1;
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  // Drops expired windows so the map can't grow without bound.
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

export function createLoginLimiterFromEnv(): LoginLimiter {
  const max = Number(process.env.LOGIN_MAX_FAILURES);
  const windowMs = Number(process.env.LOGIN_WINDOW_MS);
  return new LoginLimiter(
    Number.isFinite(max) && max > 0 ? max : 10,
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 15 * 60 * 1000,
  );
}
