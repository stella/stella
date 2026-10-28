import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { type McpProxy, startMcpProxy } from "./mcp-proxy";

const RUN_ID = "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f";
const EXPIRES = "2026-10-28T12:00:00.000Z";
const LATER = "2026-10-28T13:00:00.000Z";

type Seen = { path: string; authorization: string | null; headers: Headers };

/** A stand-in for the stella API that records what reached it. */
const upstream = () => {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      seen.push({
        path: pathname,
        authorization: request.headers.get("authorization"),
        headers: request.headers,
      });
      if (pathname === "/redirect") {
        return Response.redirect(
          `http://127.0.0.1:${server.port}/elsewhere`,
          307,
        );
      }
      return new Response(JSON.stringify({ echoed: await request.text() }), {
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
          "set-cookie": "leak=1",
          "www-authenticate": "Bearer resource_metadata=x",
        },
      });
    },
  });
  return { seen, server, origin: `http://127.0.0.1:${server.port}` };
};

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

const setup = (path = "/mcp") => {
  const api = upstream();
  const proxy = startMcpProxy({ apiOrigin: api.origin });
  stops.push(async () => {
    await proxy.stop();
    await api.server.stop(true);
  });
  const binding = proxy.register({
    runId: RUN_ID,
    serverName: "stella",
    upstreamUrl: `${api.origin}${path}`,
    token: "run-token-1",
    expiresAt: EXPIRES,
  });
  if (Result.isError(binding)) {
    return panic(binding.error.message);
  }
  return { api, proxy, binding: binding.value };
};

const call = (
  url: string,
  secret: string | null,
  headers: Record<string, string> = {},
) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

const register = (proxy: McpProxy, upstreamUrl: string) =>
  proxy.register({
    runId: crypto.randomUUID(),
    serverName: "stella",
    upstreamUrl,
    token: "run-token-1",
    expiresAt: EXPIRES,
  });

describe("loopback MCP proxy", () => {
  test("listens on loopback and hands the harness a secret, not the token", () => {
    const { proxy, binding } = setup();
    expect(proxy.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(binding.url).toBe(`${proxy.origin}/mcp/${RUN_ID}`);
    expect(binding.serverName).toBe("stella");
    expect(binding.token).not.toContain("run-token");
    expect(binding.token.length).toBeGreaterThanOrEqual(43);
  });

  test("forwards with the run token and only the MCP headers", async () => {
    const { api, binding } = setup();
    const response = await call(binding.url, binding.token, {
      "mcp-session-id": "session-1",
      cookie: "a=1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      echoed: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(api.seen).toHaveLength(1);
    const [seen] = api.seen;
    expect(seen?.path).toBe("/mcp");
    expect(seen?.authorization).toBe("Bearer run-token-1");
    expect(seen?.headers.get("mcp-session-id")).toBe("session-1");
    expect(seen?.headers.get("cookie")).toBeNull();
  });

  test("refuses a wrong or missing secret without reaching the API", async () => {
    const { api, binding } = setup();
    expect((await call(binding.url, "wrong")).status).toBe(401);
    expect((await call(binding.url, null)).status).toBe(401);
    expect((await call(binding.url, "run-token-1")).status).toBe(401);
    expect(api.seen).toEqual([]);
  });

  test("refuses a run it does not hold, and a run once unregistered", async () => {
    const { api, proxy, binding } = setup();
    const other = binding.url.replace(RUN_ID, () => crypto.randomUUID());
    expect((await call(other, binding.token)).status).toBe(404);
    proxy.unregister(RUN_ID);
    expect((await call(binding.url, binding.token)).status).toBe(404);
    expect(api.seen).toEqual([]);
  });

  test("refuses a browser page and a rebound host name", async () => {
    const { api, binding } = setup();
    expect(
      (await call(binding.url, binding.token, { origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(
      (await call(binding.url, binding.token, { host: "evil.test" })).status,
    ).toBe(403);
    expect(api.seen).toEqual([]);
  });

  test("refuses an upstream outside the configured stella API origin", () => {
    const { api, proxy } = setup();
    for (const url of [
      "https://evil.test/mcp",
      `http://localhost:${api.server.port}/mcp`,
      `http://user:secret@127.0.0.1:${api.server.port}/mcp`,
      "not a url",
    ]) {
      const refused = register(proxy, url);
      expect(Result.isError(refused) && refused.error.reason).toBe(
        "foreign_upstream",
      );
    }
    expect(Result.isOk(register(proxy, `${api.origin}/other/mcp`))).toBe(true);
  });

  test("refuses registering the same run twice", () => {
    const { api, proxy } = setup();
    const again = proxy.register({
      runId: RUN_ID,
      serverName: "stella",
      upstreamUrl: `${api.origin}/mcp`,
      token: "run-token-9",
      expiresAt: EXPIRES,
    });
    expect(Result.isError(again) && again.error.reason).toBe("duplicate_run");
  });

  test("uses a refreshed token from the next request on, never an older one", async () => {
    const { api, proxy, binding } = setup();
    await call(binding.url, binding.token);
    expect(proxy.refresh(RUN_ID, "run-token-2", LATER)).toBe(true);
    await call(binding.url, binding.token);
    expect(proxy.refresh(RUN_ID, "run-token-stale", EXPIRES)).toBe(false);
    await call(binding.url, binding.token);
    expect(proxy.refresh(crypto.randomUUID(), "run-token-3", LATER)).toBe(
      false,
    );
    expect(api.seen.map(({ authorization }) => authorization)).toEqual([
      "Bearer run-token-1",
      "Bearer run-token-2",
      "Bearer run-token-2",
    ]);
  });

  test("does not follow an upstream redirect", async () => {
    const { api, binding } = setup("/redirect");
    expect((await call(binding.url, binding.token)).status).toBe(502);
    expect(api.seen.map(({ path }) => path)).toEqual(["/redirect"]);
  });
});
