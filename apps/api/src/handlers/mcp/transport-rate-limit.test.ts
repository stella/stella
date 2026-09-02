import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  isMcpTransportRateLimitedRequest,
  MCP_RATE_LIMIT_JSON_RPC_ERROR,
  MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
  MCP_TRANSPORT_RATE_LIMIT_POLICY,
  mcpTransportAddressRateLimitKey,
  mcpTransportRateLimitKey,
} from "@/api/handlers/mcp/transport-rate-limit";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  rateLimit,
  type RequestIpServer,
} from "@/api/lib/rate-limit/rate-limit";
import {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
} from "@/api/mcp/constants";

const TOKEN = "stella_at_top_secret_value";

const ipServer = (address: string): RequestIpServer => ({
  requestIP: () => ({ address }),
});

const transportRequest = ({
  path = MCP_HTTP_PATH,
  token,
}: {
  path?: string;
  token?: string;
} = {}) =>
  new Request(`http://localhost${path}`, {
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    headers: token
      ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
      : { "content-type": "application/json" },
    method: "POST",
  });

/**
 * The shipped policy against an in-memory counter: only `max` is lowered, so
 * the keying, the skip predicate, and the 429 envelope under test are the ones
 * production wires up. The Redis binding wraps this same generator with a
 * per-request refund token, which the in-memory context does not parse.
 */
const createLimitedApp = ({
  max,
  addressMax = max * 10,
}: {
  max: number;
  addressMax?: number;
}) =>
  new Elysia()
    .use(
      rateLimit({
        ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
        context: new InMemoryRateLimitContext(),
        generator: mcpTransportAddressRateLimitKey,
        max: addressMax,
      }),
    )
    .use(
      rateLimit({
        ...MCP_TRANSPORT_RATE_LIMIT_POLICY,
        context: new InMemoryRateLimitContext(),
        generator: mcpTransportRateLimitKey,
        max,
      }),
    )
    .use(
      createMcpRoute({
        handleMcpHttpRequest: async () => new Response("transport reached"),
      }),
    );

describe("isMcpTransportRateLimitedRequest", () => {
  test("covers every JSON-RPC transport path", () => {
    for (const path of [
      MCP_HTTP_PATH,
      MCP_ANONYMIZED_HTTP_PATH,
      MCP_DOCUMENTS_HTTP_PATH,
    ]) {
      expect(isMcpTransportRateLimitedRequest(transportRequest({ path }))).toBe(
        true,
      );
    }
  });

  test("leaves discovery and preflight unmetered", () => {
    expect(
      isMcpTransportRateLimitedRequest(
        new Request(`http://localhost${MCP_DISCOVERY_PATH}`),
      ),
    ).toBe(false);
    expect(
      isMcpTransportRateLimitedRequest(
        new Request(`http://localhost${MCP_HTTP_PATH}`, { method: "OPTIONS" }),
      ),
    ).toBe(false);
  });
});

describe("mcpTransportRateLimitKey", () => {
  test("keys on a digest of the bearer token, never the token itself", async () => {
    const key = await mcpTransportRateLimitKey(
      transportRequest({ token: TOKEN }),
      ipServer("203.0.113.7"),
    );

    expect(key).not.toContain(TOKEN);
    expect(key).toMatch(/^mcp-transport:token:[0-9a-f]{64}$/u);
  });

  test("collapses one credential into one bucket across addresses and paths", async () => {
    const first = await mcpTransportRateLimitKey(
      transportRequest({ token: TOKEN }),
      ipServer("203.0.113.7"),
    );
    const second = await mcpTransportRateLimitKey(
      transportRequest({ path: MCP_DOCUMENTS_HTTP_PATH, token: TOKEN }),
      ipServer("198.51.100.4"),
    );

    expect(second).toBe(first);
  });

  test("the address key ignores the credential and follows the peer", async () => {
    const server = ipServer("203.0.113.7");
    const [first, second, elsewhere] = await Promise.all([
      mcpTransportAddressRateLimitKey(
        transportRequest({ token: TOKEN }),
        server,
      ),
      mcpTransportAddressRateLimitKey(
        transportRequest({ token: "stella_at_other_value" }),
        server,
      ),
      mcpTransportAddressRateLimitKey(
        transportRequest({ token: TOKEN }),
        ipServer("198.51.100.4"),
      ),
    ]);

    expect(first).toBe("mcp-transport-address:ip:203.0.113.7");
    expect(second).toBe(first);
    expect(elsewhere).not.toBe(first);
    expect(first).not.toContain(TOKEN);
  });

  test("separates distinct credentials and falls back to the client address", async () => {
    const server = ipServer("203.0.113.7");
    const tokenKey = await mcpTransportRateLimitKey(
      transportRequest({ token: TOKEN }),
      server,
    );
    const otherTokenKey = await mcpTransportRateLimitKey(
      transportRequest({ token: "stella_at_other_value" }),
      server,
    );
    const anonymousKey = await mcpTransportRateLimitKey(
      transportRequest(),
      server,
    );

    expect(otherTokenKey).not.toBe(tokenKey);
    expect(anonymousKey).toBe("mcp-transport:ip:203.0.113.7");
  });
});

describe("MCP transport rate limit", () => {
  test("passes traffic under the limit", async () => {
    const app = createLimitedApp({ max: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      const response = await app.handle(transportRequest({ token: TOKEN }));
      expect(response.status).toBe(200);
    }
  });

  test("answers an over-limit call with a JSON-RPC envelope and Retry-After", async () => {
    const app = createLimitedApp({ max: 1 });

    await app.handle(transportRequest({ token: TOKEN }));
    const limited = await app.handle(transportRequest({ token: TOKEN }));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe(
      limited.headers.get("RateLimit-Reset"),
    );
    expect(limited.headers.get("content-type")).toContain("application/json");
    expect(await limited.json()).toEqual(MCP_RATE_LIMIT_JSON_RPC_ERROR);
  });

  test("charges rotated bearer values to the address budget", async () => {
    const app = createLimitedApp({ max: 100, addressMax: 2 });

    const responses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      const response = await app.handle(
        transportRequest({ token: `stella_at_invented_${attempt}` }),
      );
      responses.push(response.status);
    }

    // Each invented credential is a fresh credential bucket; the address
    // bucket (one peer under `handle`) still refuses the third call.
    expect(responses).toEqual([200, 200, 429]);
  });

  test("gives each credential its own bucket", async () => {
    const app = createLimitedApp({ max: 1 });

    await app.handle(transportRequest({ token: TOKEN }));
    const otherCredential = await app.handle(
      transportRequest({ token: "stella_at_other_value" }),
    );

    expect(otherCredential.status).toBe(200);
  });

  test("never meters discovery or preflight", async () => {
    const app = createLimitedApp({ max: 1 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      const discovery = await app.handle(
        new Request(`http://localhost${MCP_DISCOVERY_PATH}`),
      );
      expect(discovery.status).toBe(200);

      // oxlint-disable-next-line no-await-in-loop -- the limiter counts requests, so they must be sequential
      const preflight = await app.handle(
        new Request(`http://localhost${MCP_HTTP_PATH}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
          method: "OPTIONS",
        }),
      );
      expect(preflight.status).toBe(200);
    }
  });

  test("ships a budget generous enough that agents are never throttled", () => {
    expect(API_RATE_LIMITS.mcpTransport).toEqual({
      duration: 60_000,
      max: 600,
    });
    expect(MCP_TRANSPORT_RATE_LIMIT_POLICY.max).toBe(
      API_RATE_LIMITS.mcpTransport.max,
    );
  });
});
