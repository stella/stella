import { describe, expect, test } from "bun:test";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import { isRateLimitMiddleware } from "@/api/lib/rate-limit/rate-limit";
import { apiApp } from "@/api/server";
import { serveForTest } from "@/api/tests/helpers/test-server";

// `/v1` routes that run without a `rateLimit` stage. Each entry needs a
// reason; a new route lands here only by an explicit decision.
const UNMETERED_V1_ROUTES = {} as const satisfies Record<string, string>;

describe("composed API rate limiting", () => {
  test("every /v1 route runs behind a rate limiter", () => {
    expect(apiApp.routes.length).toBeGreaterThan(100);
    const unmetered = apiApp.routes
      .filter(
        (route) =>
          route.path.startsWith("/v1/") &&
          !route.middleware.some(isRateLimitMiddleware),
      )
      .map((route) => `${route.method} ${route.path}`)
      .toSorted();

    expect(unmetered).toEqual(Object.keys(UNMETERED_V1_ROUTES).toSorted());
  });

  test("a signing route answers with the shared API budget", async () => {
    await using server = serveForTest(apiApp);
    // Malformed credentials answer the same 404 as unknown ones; the limiter
    // counts the request either way.
    const response = await server.fetch(
      new Request(
        "http://localhost/v1/pdf-signing-sessions/not-a-session/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("RateLimit-Limit")).toBe(
      String(API_RATE_LIMITS.api.max),
    );
  });
});
