import { afterAll, describe, expect, test } from "bun:test";

import { createHttpApp } from "@/api/http/app";
import { cacheControlFor, responseCachePolicy } from "@/api/http/cache";
import type { CachePolicy, RouteCachePolicy } from "@/api/http/cache";
import { routes } from "@/api/http/route";
import type {
  Middleware,
  RouteDefinition,
  RouteRequest,
} from "@/api/http/route";
import { status } from "@/api/http/status";
import { securityHeaders } from "@/api/lib/security-headers";
import { serveForTest } from "@/api/tests/helpers/test-server";

const publicPolicy = {
  kind: "public",
  maxAge: 300,
  swr: 60,
} as const satisfies CachePolicy;
const PUBLIC_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=60";
const PRIVATE_NO_STORE = "private, no-store";
const SSE_DIRECTIVES = "private, no-cache, no-store, no-transform";

const definition = (
  answer: (request: RouteRequest) => unknown,
  cache?: RouteCachePolicy,
): RouteDefinition => ({
  access: "public",
  config: {},
  ...(cache === undefined ? {} : { cache }),
  run: async (request) => await answer(request),
});

/** A stage inside the cache policy that fails the answer after the handler ran. */
const lateFailure: Middleware = async (ctx, inner) => {
  const response = await inner();
  return ctx.request.headers.has("x-late-failure")
    ? new Response(response.body, { status: 500, headers: response.headers })
    : response;
};

/** A stage that answers some requests itself, before any route runs. */
const earlyReply: Middleware = async (ctx, inner) =>
  ctx.path === "/early"
    ? new Response("refused", { status: 403 })
    : await inner();

const immutableRedirect = Response.redirect("http://localhost/next", 302);

const app = createHttpApp({
  middleware: [responseCachePolicy, securityHeaders, earlyReply, lateFailure],
  routes: routes({
    "/public": {
      GET: definition(({ ctx }) => {
        ctx.set.headers["Cache-Control"] = PRIVATE_NO_STORE;
        ctx.set.headers["cache-control"] = PRIVATE_NO_STORE;
        ctx.set.headers["CACHE-CONTROL"] = PRIVATE_NO_STORE;
        return { ok: true };
      }, publicPolicy),
    },
    "/public-raw": {
      GET: definition(
        () =>
          new Response("body", {
            headers: { "Cache-Control": PRIVATE_NO_STORE },
          }),
        publicPolicy,
      ),
    },
    "/private": { GET: definition(() => new Response("example")) },
    "/upstream/:code": {
      GET: definition(
        ({ ctx }) =>
          new Response("example", { status: Number(ctx.params["code"]) }),
        publicPolicy,
      ),
    },
    "/status/:code": {
      GET: definition(
        ({ ctx }) => status(Number(ctx.params["code"]), "failure"),
        publicPolicy,
      ),
    },
    "/wrapped/:code": {
      GET: definition(({ ctx }) =>
        status(Number(ctx.params["code"]), new Response("example")),
      ),
    },
    "/wrapped-inner/:code": {
      GET: definition(
        ({ ctx }) =>
          status(
            200,
            new Response("example", { status: Number(ctx.params["code"]) }),
          ),
        publicPolicy,
      ),
    },
    "/fallback": {
      GET: definition(({ ctx }) => {
        ctx.set.privateOnly = true;
        return { message: "Coverage is unavailable" };
      }, publicPolicy),
    },
    "/chosen": {
      GET: definition(({ ctx }) => {
        ctx.set.cache = { kind: "private", maxAge: 60 };
        return { ok: true };
      }, publicPolicy),
    },
    "/stream/none/:variant": {
      GET: definition(
        ({ ctx }) =>
          new Response("data: example\n\n", {
            headers: {
              "Content-Type":
                ctx.params["variant"] === "charset"
                  ? "text/event-stream; charset=utf-8"
                  : "text/event-stream",
            },
          }),
        { kind: "none" },
      ),
    },
    "/stream/public/:variant": {
      GET: definition(
        ({ ctx }) =>
          new Response("data: example\n\n", {
            headers: {
              "Content-Type":
                ctx.params["variant"] === "charset"
                  ? "text/event-stream; charset=utf-8"
                  : "text/event-stream",
            },
          }),
        publicPolicy,
      ),
    },
    "/redirect": { GET: definition(() => immutableRedirect, publicPolicy) },
    "/missing": { GET: definition(() => status(404, "missing")) },
  }),
});

const server = serveForTest(app);
afterAll(async () => {
  await server.stop();
});

const get = async (path: string, headers?: Record<string, string>) =>
  await server.fetch(new Request(`http://localhost${path}`, { headers }));

describe("response cache policy", () => {
  test("replaces every case variant with one canonical public policy", async () => {
    for (const path of ["/public", "/public-raw"]) {
      const response = await get(path);
      expect(response.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    }
  });

  test("only successful statuses opt into public caching", () => {
    for (let code = 200; code <= 599; code++) {
      expect(
        cacheControlFor(new Response(null, { status: code }), {
          cache: publicPolicy,
          privateOnly: false,
        }),
      ).toBe(code < 300 ? PUBLIC_CACHE_CONTROL : PRIVATE_NO_STORE);
    }
  });

  test("status wrappers and upstream errors stay private", async () => {
    for (const code of [400, 401, 403, 404, 422, 429, 500, 503] as const) {
      const upstream = await get(`/upstream/${code}`);
      expect(upstream.status).toBe(code);
      expect(upstream.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
      const wrapped = await get(`/status/${code}`);
      expect(wrapped.status).toBe(code);
      expect(wrapped.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
    }
  });

  test("unavailable successful fallbacks never become public", async () => {
    const response = await get("/fallback");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  test("a policy the handler chose at run time wins over the declared one", async () => {
    const response = await get("/chosen");
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
  });

  test("raw responses use the declared default policy", async () => {
    const response = await get("/private");
    expect(response.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  test("event streams keep their directives whatever the declared policy", async () => {
    for (const variant of ["plain", "charset"]) {
      for (const cache of ["none", "public"]) {
        const response = await get(`/stream/${cache}/${variant}`);
        expect(response.headers.get("cache-control")).toBe(SSE_DIRECTIVES);
      }
    }
  });

  test("late errors revoke an earlier successful public policy", async () => {
    for (const path of ["/public", "/public-raw"]) {
      const response = await get(path, { "x-late-failure": "true" });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
    }
  });

  test("immutable upstream headers are copied at the response boundary", async () => {
    const response = await get("/redirect");
    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe(PRIVATE_NO_STORE);
    expect(immutableRedirect.headers.get("Cache-Control")).toBeNull();
  });

  test("wrapped raw responses take the wrapper's status and stay private", async () => {
    for (const code of [200, 404, 500] as const) {
      const response = await get(`/wrapped/${code}`);
      expect(response.status).toBe(code);
      expect(response.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
    }
  });

  test("wrapped response policies follow the effective status", async () => {
    for (const innerStatus of [200, 404, 503] as const) {
      const response = await get(`/wrapped-inner/${innerStatus}`);
      expect(response.status).toBe(innerStatus);
      expect(response.headers.get("Cache-Control")).toBe(
        innerStatus === 200 ? PUBLIC_CACHE_CONTROL : PRIVATE_NO_STORE,
      );
    }
  });

  test("emits one header for raw responses, statuses and early replies", async () => {
    for (const [path, expected] of [
      ["/private", PRIVATE_NO_STORE],
      ["/public-raw", PUBLIC_CACHE_CONTROL],
      ["/missing", PRIVATE_NO_STORE],
      ["/early", PRIVATE_NO_STORE],
      ["/stream/none/plain", SSE_DIRECTIVES],
    ] as const) {
      const response = await get(path);
      expect(response.headers.get("cache-control")).toBe(expected);
    }
  });
});

test("only an answer, never a route, declares a private lifetime", () => {
  const perAnswer: CachePolicy = { kind: "private", maxAge: 60 };
  // @ts-expect-error -- a route's answers include failures, which are never kept.
  const perRoute: RouteCachePolicy = { kind: "private", maxAge: 60 };
  expect([perAnswer.kind, perRoute.kind]).toEqual(["private", "private"]);
});
