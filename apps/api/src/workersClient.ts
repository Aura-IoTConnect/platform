const WORKERS_URL = process.env.WORKERS_URL ?? "http://localhost:8000";
const WORKERS_API_TOKEN = process.env.WORKERS_API_TOKEN;

// Generous enough for a real anomaly-explainer/alert-triage Claude call
// (can legitimately take several seconds), short enough to bound a request
// against a hung apps/workers instead of hanging until Node's own socket
// timeout — a bare TCP RST gives a fast rejection, but a half-dead process
// holding the port open without responding does not, and fetch() has no
// default timeout of its own.
const WORKERS_TIMEOUT_MS = 30_000;

/**
 * Server-to-server call into apps/workers. WORKERS_API_TOKEN lives only
 * here — never sent to the browser — unlike the old direct browser->workers
 * calls this replaces (see CLAUDE.md). Status/body are passed through as-is
 * so callers can forward workers' 503 ("agents not configured") verbatim.
 */
export async function callWorkers(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${WORKERS_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(WORKERS_API_TOKEN ? { authorization: `Bearer ${WORKERS_API_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WORKERS_TIMEOUT_MS),
    });
  } catch {
    // Covers both "unreachable" (down, wrong WORKERS_URL — rejects fast)
    // and "unresponsive" (hung process holding the port — rejects once the
    // timeout above fires) the same way. This is Express 4 — an uncaught
    // rejection here would crash the whole process rather than become a
    // 500, since Express 4 doesn't catch async route errors. Every caller
    // gets a normal {status, data} back instead.
    return { status: 502, data: { error: "apps/workers is unreachable" } };
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
