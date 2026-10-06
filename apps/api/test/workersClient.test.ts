import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// workersClient reads WORKERS_URL / WORKERS_API_TOKEN once at import time, so
// each test sets the env first and then imports a fresh copy of the module.
async function loadClient(env: { url?: string; token?: string } = {}) {
  vi.resetModules();
  process.env.WORKERS_URL = env.url ?? "http://workers.test";
  if (env.token === undefined) delete process.env.WORKERS_API_TOKEN;
  else process.env.WORKERS_API_TOKEN = env.token;
  return (await import("../src/workersClient.js")).callWorkers;
}

describe("callWorkers", () => {
  const fetchMock = vi.fn();
  const saved = { url: process.env.WORKERS_URL, token: process.env.WORKERS_API_TOKEN };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved.url === undefined) delete process.env.WORKERS_URL;
    else process.env.WORKERS_URL = saved.url;
    if (saved.token === undefined) delete process.env.WORKERS_API_TOKEN;
    else process.env.WORKERS_API_TOKEN = saved.token;
  });

  it("POSTs JSON to WORKERS_URL + path and returns the status and parsed body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 201 }));
    const callWorkers = await loadClient();

    const result = await callWorkers("/agents/x/run", { a: 1 });

    expect(result).toEqual({ status: 201, data: { ok: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://workers.test/agents/x/run");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("attaches WORKERS_API_TOKEN as a bearer token when one is configured", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    const callWorkers = await loadClient({ token: "shh" });

    await callWorkers("/x", {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer shh" });
  });

  it("sends no Authorization header when no token is configured (open dev default)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    const callWorkers = await loadClient();

    await callWorkers("/x", {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("returns a 502 instead of throwing when workers is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const callWorkers = await loadClient();

    const result = await callWorkers("/x", {});

    expect(result.status).toBe(502);
    expect(result.data).toEqual({ error: "apps/workers is unreachable" });
  });

  it("passes a workers error status through unchanged", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "no key" }), { status: 503 }));
    const callWorkers = await loadClient();

    expect(await callWorkers("/x", {})).toEqual({ status: 503, data: { detail: "no key" } });
  });

  it("tolerates a non-JSON response body (data is null, status still reported)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    const callWorkers = await loadClient();

    expect(await callWorkers("/x", {})).toEqual({ status: 502, data: null });
  });

  it("DELETE sends no body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    const callWorkers = await loadClient();

    await callWorkers("/devices/1/mqtt-credentials", {}, "DELETE");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});
