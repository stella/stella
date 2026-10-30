import { describe, expect, mock, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex as legacyHex } from "@stll/sha256/node";

import { env } from "@/api/env";
import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import {
  createMcpAuthenticationFailureLimiter,
  MCP_RATE_LIMIT_JSON_RPC_ERROR,
  MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
  MCP_TRANSPORT_RATE_LIMIT_POLICY,
  mcpTransportAddressRateLimitKey,
  mcpTransportRateLimitKey,
} from "@/api/handlers/mcp/transport-rate-limit";
import { createHttpApp } from "@/api/http/app";
import type { Middleware } from "@/api/http/route";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import type { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type {
  RateLimitGenerator,
  RequestIpServer,
} from "@/api/lib/rate-limit/contracts";
import {
  InMemoryRateLimitContext,
  rateLimit,
} from "@/api/lib/rate-limit/rate-limit";
import {
  MCP_ADVANCED_HTTP_PATH,
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_LAW_HTTP_PATH,
} from "@/api/mcp/constants";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

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

type McpRouteOptions = Parameters<typeof createMcpRoute>[0];

/** The MCP routes served on a real port behind the error boundary. */
const serveMcp = (options: McpRouteOptions) =>
  serveForTest(
    createHttpApp({
      routes: createMcpRoute(options),
      middleware: [errorBoundary],
    }),
  );

/**
 * The shipped address key, recording each key it hands out: a request served
 * over a real socket is keyed by its peer address, which the test reads back
 * instead of assuming.
 */
const recordingAddressKey = () => {
  const keys = new Set<string>();
  const generator: RateLimitGenerator = async (request, server) => {
    const key = await mcpTransportAddressRateLimitKey(request, server);
    keys.add(key);
    return key;
  };
  return { generator, keys: () => [...keys] };
};

/**
 * The shipped policy against an in-memory counter: only `max` is lowered, so
 * the keying, the route composition, and the 429 envelope under test are the
 * ones production wires up. The Redis binding wraps this same generator with
 * a per-request refund token, which the in-memory context does not parse.
 */
const serveLimited = ({
  max,
  addressMax = max * 10,
}: {
  max: number;
  addressMax?: number;
}) =>
  serveMcp({
    handleMcpHttpRequest: async (request) =>
      new Response("transport reached", {
        status:
          request.headers
            .get("authorization")
            ?.includes("stella_at_example_") ||
          !request.headers.has("authorization")
            ? 401
            : 200,
        headers: { "WWW-Authenticate": 'Bearer realm="mcp"' },
      }),
    limitAuthenticationFailure: createMcpAuthenticationFailureLimiter({
      ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
      context: new InMemoryRateLimitContext(),
      generator: mcpTransportAddressRateLimitKey,
      max: addressMax,
    }),
    // The production composition: the transport budget is a stage of the
    // JSON-RPC transport routes only.
    transportMiddleware: [
      rateLimit({
        ...MCP_TRANSPORT_RATE_LIMIT_POLICY,
        context: new InMemoryRateLimitContext(),
        generator: mcpTransportRateLimitKey,
        max,
      }),
    ],
  });

describe("MCP transport budget placement", () => {
  /** A transport-only stage that counts the requests it sees. */
  const serveCounted = () => {
    let metered = 0;
    const meter: Middleware = async (_ctx, inner) => {
      metered += 1;
      return await inner();
    };
    const server = serveMcp({
      handleMcpHttpRequest: async () => new Response(null, { status: 200 }),
      transportMiddleware: [meter],
    });
    return { server, metered: () => metered };
  };

  test("covers every JSON-RPC transport path", async () => {
    const { server, metered } = serveCounted();
    await using app = server;
    for (const path of [
      MCP_HTTP_PATH,
      MCP_ADVANCED_HTTP_PATH,
      MCP_ANONYMIZED_HTTP_PATH,
      MCP_DOCUMENTS_HTTP_PATH,
      MCP_LAW_HTTP_PATH,
    ]) {
      const before = metered();
      expect((await app.fetch(transportRequest({ path }))).status).toBe(200);
      expect({ path, metered: metered() - before }).toEqual({
        path,
        metered: 1,
      });
    }
  });

  test("leaves discovery and preflight unmetered", async () => {
    const { server, metered } = serveCounted();
    await using app = server;
    expect(
      (await app.fetch(new Request(`http://localhost${MCP_DISCOVERY_PATH}`)))
        .status,
    ).toBe(200);
    // The transport preflight answers itself, without a body.
    expect(
      (
        await app.fetch(
          new Request(`http://localhost${MCP_HTTP_PATH}`, {
            method: "OPTIONS",
          }),
        )
      ).status,
    ).toBe(204);
    expect(metered()).toBe(0);
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
    await using app = serveLimited({ max: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.fetch(transportRequest({ token: TOKEN }));
      expect(response.status).toBe(200);
    }
  });

  test("answers an over-limit call with a JSON-RPC envelope and Retry-After", async () => {
    await using app = serveLimited({ max: 1 });

    await app.fetch(transportRequest({ token: TOKEN }));
    const limited = await app.fetch(transportRequest({ token: TOKEN }));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe(
      limited.headers.get("RateLimit-Reset"),
    );
    expect(limited.headers.get("content-type")).toContain("application/json");
    expect(await limited.json()).toEqual(MCP_RATE_LIMIT_JSON_RPC_ERROR);
  });

  test("authentication failures share the address budget", async () => {
    await using app = serveLimited({ max: 100, addressMax: 2 });

    const responses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.fetch(
        transportRequest({ token: `stella_at_example_${attempt}` }),
      );
      responses.push(response.status);
    }

    // Distinct invalid credentials remain in the shared anonymous address budget.
    expect(responses).toEqual([401, 401, 429]);
  });

  test("accepted credentials do not consume the shared anonymous address budget", async () => {
    await using app = serveLimited({ max: 1, addressMax: 1 });
    for (const path of [
      MCP_HTTP_PATH,
      MCP_ANONYMIZED_HTTP_PATH,
      MCP_DOCUMENTS_HTTP_PATH,
      MCP_LAW_HTTP_PATH,
    ]) {
      expect(
        (await app.fetch(transportRequest({ path, token: `valid_${path}` })))
          .status,
      ).toBe(200);
    }
    expect((await app.fetch(transportRequest())).status).toBe(401);
    const limited = await app.fetch(
      transportRequest({ token: "stella_at_example_1" }),
    );
    expect(limited.status).toBe(429);
    // Admission runs before authentication can issue a challenge.
    expect(limited.headers.get("WWW-Authenticate")).toBeNull();
    expect((await app.fetch(transportRequest({ token: TOKEN }))).status).toBe(
      429,
    );
  });

  test("gives each credential its own bucket", async () => {
    await using app = serveLimited({ max: 1 });

    await app.fetch(transportRequest({ token: TOKEN }));
    const otherCredential = await app.fetch(
      transportRequest({ token: "stella_at_other_value" }),
    );

    expect(otherCredential.status).toBe(200);
  });

  test("never meters discovery or preflight", async () => {
    await using app = serveLimited({ max: 1 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const discovery = await app.fetch(
        new Request(`http://localhost${MCP_DISCOVERY_PATH}`),
      );
      expect(discovery.status).toBe(200);

      const preflight = await app.fetch(
        new Request(`http://localhost${MCP_HTTP_PATH}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
          method: "OPTIONS",
        }),
      );
      // The transport preflight answers itself, without a body.
      expect(preflight.status).toBe(204);
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

test("credential rate-limit keys retain legacy UTF-8 token bytes", async () => {
  for (const token of ["abc", "Élève-é"]) {
    const request = transportRequest({ token });
    expect(
      await mcpTransportRateLimitKey(request, ipServer("203.0.113.7")),
    ).toBe(`mcp-transport:token:${legacyHex(token)}`);
  }
});

test("transport budgets classify generated keys without exposing credentials", async () => {
  const key = await mcpTransportRateLimitKey(
    transportRequest({ token: TOKEN }),
    ipServer("192.0.2.10"),
  );
  expect(MCP_TRANSPORT_RATE_LIMIT_POLICY.budget(key)).toEqual({
    name: "mcp.transport.bearer",
    keyKind: "bearer",
  });
  const anonymousKey = await mcpTransportRateLimitKey(
    transportRequest(),
    ipServer("192.0.2.10"),
  );
  expect(MCP_TRANSPORT_RATE_LIMIT_POLICY.budget(anonymousKey)).toEqual({
    name: "mcp.transport.address",
    keyKind: "address",
  });
  expect(MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY.budget).toEqual({
    name: "mcp.authentication.address",
    keyKind: "address",
  });
});

test("authentication address refusals emit one bounded budget observation", async () => {
  const observations: Parameters<typeof recordBudgetRejection>[0][] = [];
  const context = new InMemoryRateLimitContext();
  const limiter = createMcpAuthenticationFailureLimiter(
    {
      ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
      context,
      generator: mcpTransportAddressRateLimitKey,
      max: 1,
    },
    (observation) => {
      observations.push(observation);
    },
  );
  const request = transportRequest({ token: "invalid-credential" });
  try {
    expect(
      (
        await limiter({
          request,
          run: async () => new Response(null, { status: 200 }),
          clientIp: "192.0.2.10",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await limiter({
          request,
          run: async () => new Response(null, { status: 401 }),
          clientIp: "192.0.2.10",
        })
      ).status,
    ).toBe(401);
    expect(observations).toEqual([]);
    expect(
      (
        await limiter({
          request,
          run: async () => new Response(null, { status: 401 }),
          clientIp: "192.0.2.10",
        })
      ).status,
    ).toBe(429);
    expect(observations).toEqual([
      {
        name: "mcp.authentication.address",
        keyKind: "address",
        windowMs: MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY.duration,
      },
    ]);
  } finally {
    context.kill();
  }
});

test("an exhausted address rejects a new bearer before verification", async () => {
  const context = new InMemoryRateLimitContext();
  const observations: Parameters<typeof recordBudgetRejection>[0][] = [];
  const verify = mock(async () => new Response(null, { status: 401 }));
  const address = recordingAddressKey();
  const limiter = createMcpAuthenticationFailureLimiter(
    {
      ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
      context,
      generator: address.generator,
      max: 2,
    },
    (observation) => {
      observations.push(observation);
    },
  );
  await using app = serveMcp({
    handleMcpHttpRequest: verify,
    limitAuthenticationFailure: limiter,
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        (await app.fetch(transportRequest({ token: `invalid_${attempt}` })))
          .status,
      ).toBe(401);
    }
    verify.mockClear();
    const response = await app.fetch(transportRequest({ token: "new-bearer" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(await response.json()).toEqual(MCP_RATE_LIMIT_JSON_RPC_ERROR);
    expect(verify).not.toHaveBeenCalled();
    // One shared address bucket, keyed by the peer the server saw.
    expect(address.keys().map((key) => context.read(key)?.count)).toEqual([2]);
    expect(observations).toHaveLength(1);
    expect(
      observations.every(
        (observation) =>
          observation.name === "mcp.authentication.address" &&
          observation.keyKind === "address",
      ),
    ).toBe(true);
  } finally {
    context.kill();
  }
});

test("accepted credentials refund their address reservation", async () => {
  const context = new InMemoryRateLimitContext();
  const address = recordingAddressKey();
  const limiter = createMcpAuthenticationFailureLimiter({
    ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
    context,
    generator: address.generator,
    max: 1,
  });
  await using app = serveMcp({
    handleMcpHttpRequest: async () => new Response(null, { status: 200 }),
    limitAuthenticationFailure: limiter,
  });
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (await app.fetch(transportRequest({ token: `valid_${attempt}` })))
          .status,
      ).toBe(200);
    }
    expect(address.keys().map((key) => context.read(key)?.count)).toEqual([0]);
  } finally {
    context.kill();
  }
});

test("a verification exception releases its reservation for a later request", async () => {
  const context = new InMemoryRateLimitContext();
  const limiter = createMcpAuthenticationFailureLimiter({
    ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
    context,
    generator: mcpTransportAddressRateLimitKey,
    max: 1,
  });
  const request = transportRequest({ token: TOKEN });
  const failure = new TypeError("Verification failed");
  try {
    expect(
      await rejectionOf(
        limiter({
          request,
          run: async () => {
            throw failure;
          },
        }),
      ),
    ).toBe(failure);
    const accepted = new Response(null, { status: 200 });
    expect(await limiter({ request, run: async () => accepted })).toBe(
      accepted,
    );
    expect(context.read("mcp-transport-address")?.count).toBe(0);
  } finally {
    context.kill();
  }
});

test("concurrent pending verification admits exactly the address maximum", async () => {
  const maximum = 3;
  const total = 12;
  const context = new InMemoryRateLimitContext();
  const verification = Promise.withResolvers<undefined>();
  const arrived = Promise.withResolvers<undefined>();
  let arrivals = 0;
  const recordArrival = () => {
    arrivals += 1;
    if (arrivals === total) {
      arrived.resolve(undefined);
    }
  };
  const verify = mock(async () => {
    recordArrival();
    await verification.promise;
    return new Response(null, { status: 401 });
  });
  const address = recordingAddressKey();
  const limiter = createMcpAuthenticationFailureLimiter({
    ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
    context,
    generator: address.generator,
    max: maximum,
  });
  await using app = serveMcp({
    handleMcpHttpRequest: verify,
    limitAuthenticationFailure: limiter,
  });
  const pending = Array.from({ length: total }, async (_, index) => {
    const response = await app.fetch(
      transportRequest({ token: `invalid_${index}` }),
    );
    if (response.status === 429) {
      recordArrival();
    }
    return response;
  });
  try {
    // Every request has reached either verification or rejection. Verification
    // remains held, so this assertion measures admission rather than completion.
    await arrived.promise;
    expect(verify).toHaveBeenCalledTimes(maximum);
    expect(address.keys().map((key) => context.read(key)?.count)).toEqual([
      maximum,
    ]);
    verification.resolve(undefined);
    const responses = await Promise.all(pending);
    expect(
      responses.filter((response) => response.status === 401),
    ).toHaveLength(maximum);
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(total - maximum);
    // Refused attempts have refunded their reservations; retained quota is
    // exactly the admitted authentication failures.
    expect(address.keys().map((key) => context.read(key)?.count)).toEqual([
      maximum,
    ]);
  } finally {
    verification.resolve(undefined);
    await Promise.allSettled(pending);
    context.kill();
  }
});

test.each(["e2e", "skip"] as const)(
  "authentication admission and charging honor %s",
  async (mode) => {
    const context = new InMemoryRateLimitContext();
    const observations: Parameters<typeof recordBudgetRejection>[0][] = [];
    const limiter = createMcpAuthenticationFailureLimiter(
      {
        ...MCP_TRANSPORT_ADDRESS_RATE_LIMIT_POLICY,
        context,
        generator: mcpTransportAddressRateLimitKey,
        max: 1,
        skip: async () => mode === "skip",
      },
      (observation) => {
        observations.push(observation);
      },
    );
    try {
      const request = transportRequest({ token: "invalid" });
      context.increment("mcp-transport-address");
      testState.setConfig("E2E_DISABLE_AUTH_RATE_LIMIT", mode === "e2e");
      expect(
        (
          await limiter({
            request,
            run: async () => new Response(null, { status: 401 }),
          })
        ).status,
      ).toBe(401);
      expect(context.read("mcp-transport-address")?.count).toBe(1);
      expect(observations).toEqual([]);
    } finally {
      context.kill();
    }
  },
);
