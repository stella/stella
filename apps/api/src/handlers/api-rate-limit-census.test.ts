import { describe, expect, test } from "bun:test";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import { isRateLimitHook } from "@/api/lib/rate-limit/rate-limit";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import api from "@/api/server";

// `/v1` routes that run without a `rateLimit` before-handle hook. Each entry
// needs a reason; a new route lands here only by an explicit decision.
const UNMETERED_V1_ROUTES = {} as const satisfies Record<string, string>;

// Elysia stores lifecycle hook containers outside LocalHook's declared type.
const hasRateLimitHook = (hooks: unknown): boolean => {
  if (!isRecord(hooks)) {
    return false;
  }
  const beforeHandle = hooks["beforeHandle"];
  return (
    isUnknownArray(beforeHandle) &&
    beforeHandle.some((hook) => isRecord(hook) && isRateLimitHook(hook["fn"]))
  );
};

describe("composed API rate limiting", () => {
  test("every /v1 route runs behind a rate limiter", () => {
    expect(api.routes.length).toBeGreaterThan(100);
    const unmetered = api.routes
      .filter(
        (route) =>
          route.path.startsWith("/v1/") && !hasRateLimitHook(route.hooks),
      )
      .map((route) => `${route.method} ${route.path}`)
      .toSorted();

    expect(unmetered).toEqual(Object.keys(UNMETERED_V1_ROUTES).toSorted());
  });

  test("a signing route answers with the shared API budget", async () => {
    // Malformed credentials answer the same 404 as unknown ones; the limiter
    // counts the request either way.
    const response = await api.handle(
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
