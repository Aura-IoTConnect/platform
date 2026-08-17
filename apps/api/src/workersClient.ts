const WORKERS_URL = process.env.WORKERS_URL ?? "http://localhost:8000";
const WORKERS_API_TOKEN = process.env.WORKERS_API_TOKEN;

/**
 * Server-to-server call into apps/workers. WORKERS_API_TOKEN lives only
 * here — never sent to the browser — unlike the old direct browser->workers
 * calls this replaces (see CLAUDE.md). Status/body are passed through as-is
 * so callers can forward workers' 503 ("agents not configured") verbatim.
 */
export async function callWorkers(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${WORKERS_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(WORKERS_API_TOKEN ? { authorization: `Bearer ${WORKERS_API_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
