import { afterAll, describe, expect, test } from "bun:test";

import { authMetadataRoute } from "@/api/handlers/auth/routes";
import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { createHttpApp } from "@/api/http/app";
import { PRIVATE_CACHE_CONTROL, responseCachePolicy } from "@/api/http/cache";
import type { CachePolicy } from "@/api/http/cache";
import { appendSetCookieHeaders } from "@/api/http/context";
import { routes } from "@/api/http/route";
import type {
  Middleware,
  RouteDefinition,
  RouteRequest,
} from "@/api/http/route";
import {
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  API_SECURITY_HEADERS,
  DISCOVERY_METADATA_CACHE_POLICY,
  RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
  securityHeaders,
} from "@/api/lib/security-headers";
import {
  MCP_RESOURCE_MODE_CONFIG,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/resource-policy-contract";
import { serveForTest } from "@/api/tests/helpers/test-server";

const DISCOVERY_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=3600";

const advertisedDiscoveryPaths = new Set([
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_MCP_DISCOVERY_PATH,
  ...Object.values(MCP_RESOURCE_MODE_CONFIG).map(
    ({ discoveryPath }) => discoveryPath,
  ),
]);

const definition = (
  answer: (request: RouteRequest) => unknown,
  cache?: CachePolicy,
): RouteDefinition => ({
  access: "public",
  config: {},
  ...(cache === undefined ? {} : { cache }),
  run: async (request) => await answer(request),
});

/** Turns any answer into a 500 after the handler ran, as a late failure would. */
const lateFailure: Middleware = async (ctx, inner) => {
  const response = await inner();
  return ctx.request.headers.has("x-late-failure")
    ? new Response("failed", { status: 500, headers: response.headers })
    : response;
};

const servers: { stop: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const serve = (app: ReturnType<typeof createHttpApp>) => {
  const server = serveForTest(app);
  servers.push(server);
  return server;
};

// The production order: the error boundary sits inside the security headers,
// so a refusal it answers (an unrouted path) leaves through them too.
const discoveryPolicyServer = serve(
  createHttpApp({
    middleware: [responseCachePolicy, securityHeaders, errorBoundary],
    routes: routes({
      "/discovery": {
        GET: definition(({ ctx }) => {
          if (ctx.request.headers.has("x-force-error")) {
            ctx.set.status = 404;
            return { error: "not found" };
          }
          return { ok: true };
        }, DISCOVERY_METADATA_CACHE_POLICY),
      },
      "/private": { GET: definition(() => ({ ok: true })) },
    }),
  }),
);

describe("discovery metadata cache policy", () => {
  test("every advertised discovery path is served with the discovery cache policy", () => {
    const mounted = [
      ...authMetadataRoute,
      ...createMcpRoute({
        handleMcpHttpRequest: async () =>
          await Promise.resolve(new Response("Unexpected MCP transport")),
      }),
    ];
    const discoveryPaths = new Set(
      mounted
        .filter(
          (entry) =>
            entry.method === "GET" &&
            entry.definition.cache === DISCOVERY_METADATA_CACHE_POLICY,
        )
        .map((entry) => entry.path),
    );
    expect(discoveryPaths).toEqual(advertisedDiscoveryPaths);
  });

  test("a discovery answer is publicly cacheable for GET and HEAD", async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await discoveryPolicyServer.fetch(
        new Request("http://localhost/discovery", { method }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        DISCOVERY_CACHE_CONTROL,
      );
    }
  });

  test("keeps discovery errors and non-discovery responses private", async () => {
    const discoveryError = await discoveryPolicyServer.fetch(
      new Request("http://localhost/discovery", {
        headers: { "x-force-error": "true" },
      }),
    );
    expect(discoveryError.status).toBe(404);
    expect(discoveryError.headers.get("cache-control")).toBe(
      PRIVATE_CACHE_CONTROL,
    );

    const privateResponse = await discoveryPolicyServer.fetch(
      new Request("http://localhost/private"),
    );
    expect(privateResponse.status).toBe(200);
    expect(privateResponse.headers.get("cache-control")).toBe(
      PRIVATE_CACHE_CONTROL,
    );
  });

  test("every answer carries the API security headers", async () => {
    const response = await discoveryPolicyServer.fetch(
      new Request("http://localhost/nowhere"),
    );
    expect(response.status).toBe(404);
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});

describe("raw document response security", () => {
  test("prevents sensitive document bytes from being cached", () => {
    const response = new Response(new Uint8Array([1]), {
      headers: RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    });

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

test("private icon caching survives finalization while late errors remain uncacheable", async () => {
  const server = serve(
    createHttpApp({
      middleware: [responseCachePolicy, lateFailure],
      routes: routes({
        "/icon": {
          GET: definition(
            () => new Blob([new Uint8Array([1])], { type: "image/png" }),
            { kind: "private", maxAge: 3600 },
          ),
        },
      }),
    }),
  );
  const icon = await server.fetch(new Request("http://localhost/icon"));
  expect(icon.status).toBe(200);
  expect(icon.headers.get("cache-control")).toBe("private, max-age=3600");

  const failed = await server.fetch(
    new Request("http://localhost/icon", {
      headers: { "x-late-failure": "true" },
    }),
  );
  expect(failed.status).toBe(500);
  expect(failed.headers.get("cache-control")).toBe("private, no-store");
});

describe("response cookies prevent public caching", () => {
  const RENEWED_COOKIE = "session=renewed; HttpOnly; Path=/";
  const publicCache: CachePolicy = { kind: "public", maxAge: 300 };

  const cookieServer = serve(
    createHttpApp({
      middleware: [responseCachePolicy],
      routes: routes({
        "/pending": {
          GET: definition(({ ctx }) => {
            ctx.set.headers["set-cookie"] = RENEWED_COOKIE;
            return new Response("public representation");
          }, publicCache),
        },
        "/response": {
          GET: definition(
            () =>
              new Response("public representation", {
                headers: { "set-cookie": RENEWED_COOKIE },
              }),
            publicCache,
          ),
        },
        // A Better Auth answer that refreshed the session hands its cookies
        // to the request being answered.
        "/auth-answer": {
          GET: definition(({ ctx }) => {
            appendSetCookieHeaders(
              ctx.set.headers,
              new Headers({ "set-cookie": RENEWED_COOKIE }),
            );
            return new Response("public representation");
          }, publicCache),
        },
        "/public": {
          GET: definition(
            () => new Response("public representation"),
            publicCache,
          ),
        },
      }),
    }),
  );

  test("an answer without a cookie keeps its public policy", async () => {
    const response = await cookieServer.fetch(
      new Request("http://localhost/public"),
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test.each(["pending", "response", "auth-answer"] as const)(
    "keeps an otherwise public response private when a late cookie comes from %s",
    async (source) => {
      const response = await cookieServer.fetch(
        new Request(`http://localhost/${source}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      expect(response.headers.getSetCookie().at(0)).toContain(
        "session=renewed",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  test("checks pending cookie headers without depending on header casing", async () => {
    for (const name of ["set-cookie", "Set-Cookie", "SET-COOKIE"]) {
      const server = serve(
        createHttpApp({
          middleware: [responseCachePolicy],
          routes: routes({
            "/": {
              GET: definition(({ ctx }) => {
                ctx.set.headers[name] = "session=renewed; Path=/";
                return { ok: true };
              }, publicCache),
            },
          }),
        }),
      );
      const response = await server.fetch(new Request("http://localhost/"));
      expect(response.headers.getSetCookie()).toEqual([
        "session=renewed; Path=/",
      ]);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
