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
  const listener = { origin: "" };
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
        return Response.redirect(`${listener.origin}/elsewhere`, 307);
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
  listener.origin = server.url.origin;
  return { seen, server, origin: listener.origin };
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

const call = async (
  url: string,
  secret: string | null,
  headers: Record<string, string> = {},
) =>
  await fetch(url, {
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
    const port = api.server.port ?? panic("The stand-in API has no TCP port.");
    for (const url of [
      "https://evil.test/mcp",
      `http://localhost:${String(port)}/mcp`,
      `http://user:secret@127.0.0.1:${String(port)}/mcp`,
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

describe("the endpoint of a harness process kept for the chat's next turn", () => {
  const NEXT_RUN = "4d2c9a7e-1b3f-4e6a-8c5d-2f1e0a9b8c7d";
  const nextRun = (origin: string, path = "/mcp") => ({
    runId: NEXT_RUN,
    serverName: "stella",
    upstreamUrl: `${origin}${path}`,
    token: "run-token-next",
    expiresAt: LATER,
  });

  test("forwards nothing while parked, then the adopting run's token at the same address", async () => {
    const { api, proxy, binding } = setup();
    const endpoint = proxy.park(RUN_ID);
    expect(endpoint).not.toBeNull();
    expect((await call(binding.url, binding.token)).status).toBe(404);
    expect(proxy.tokenOf(RUN_ID)).toBeNull();
    const adopted = proxy.adopt(
      endpoint ?? "",
      nextRun(api.origin, "/mcp-next"),
    );
    if (Result.isError(adopted)) {
      throw new TypeError(adopted.error.message);
    }
    // The process keeps the address and secret it was configured with.
    expect(adopted.value).toEqual(binding);
    expect((await call(binding.url, binding.token)).status).toBe(200);
    expect(proxy.tokenOf(NEXT_RUN)).toBe("run-token-next");
    expect(proxy.refresh(NEXT_RUN, "run-token-later", LATER)).toBe(true);
    await call(binding.url, binding.token);
    expect(
      api.seen.map(({ path, authorization }) => [path, authorization]),
    ).toEqual([
      ["/mcp-next", "Bearer run-token-next"],
      ["/mcp-next", "Bearer run-token-later"],
    ]);
    // The run that adopted it takes it along when it ends.
    proxy.unregister(NEXT_RUN);
    expect((await call(binding.url, binding.token)).status).toBe(404);
  });

  test("is adopted once, only on the stella origin, and goes when dropped", async () => {
    const { api, proxy } = setup();
    const endpoint = proxy.park(RUN_ID) ?? panic("parked");
    const foreign = proxy.adopt(endpoint, nextRun("https://elsewhere.example"));
    expect(Result.isError(foreign) && foreign.error.reason).toBe(
      "foreign_upstream",
    );
    expect(Result.isOk(proxy.adopt(endpoint, nextRun(api.origin)))).toBe(true);
    const again = proxy.adopt(endpoint, {
      ...nextRun(api.origin),
      runId: crypto.randomUUID(),
    });
    expect(Result.isError(again) && again.error.reason).toBe("not_parked");
    // An adopted endpoint belongs to its run: dropping it changes nothing.
    proxy.drop(endpoint);
    expect(proxy.tokenOf(NEXT_RUN)).toBe("run-token-next");
    proxy.unregister(NEXT_RUN);
    expect(proxy.park(NEXT_RUN)).toBeNull();
  });

  test("a dropped endpoint cannot be adopted", async () => {
    const { api, proxy } = setup();
    const endpoint = proxy.park(RUN_ID) ?? panic("parked");
    proxy.drop(endpoint);
    const adopted = proxy.adopt(endpoint, nextRun(api.origin));
    expect(Result.isError(adopted) && adopted.error.reason).toBe("not_parked");
  });
});
