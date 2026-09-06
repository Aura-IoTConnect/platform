const WORKERS_URL = process.env.WORKERS_URL ?? "http://localhost:8000";
const WORKERS_API_TOKEN = process.env.WORKERS_API_TOKEN;

/**
 * Server-to-server call into apps/workers. WORKERS_API_TOKEN lives only
 * here — never sent to the browser — unlike the old direct browser->workers
 * calls this replaces (see CLAUDE.md). Status/body are passed through as-is
 * so callers can forward workers' 503 ("agents not configured") verbatim.
 */
export async function callWorkers(
  path: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${WORKERS_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(WORKERS_API_TOKEN ? { authorization: `Bearer ${WORKERS_API_TOKEN}` } : {}),
      },
      body: method === "DELETE" ? undefined : JSON.stringify(body),
    });
  } catch {
    // apps/workers unreachable (down, wrong WORKERS_URL, etc). This is
    // Express 4 — an uncaught rejection here would crash the whole process
    // rather than become a 500, since Express 4 doesn't catch async route
    // errors. Every caller gets a normal {status, data} back instead.
    return { status: 502, data: { error: "apps/workers is unreachable" } };
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
