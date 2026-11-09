import { describe, expect, test } from "bun:test";

import { withCorpusRetryAfter } from "@/api/lib/legal-search/corpus-retry-after";

const SEARCH = "/v1/case/decisions/search";

describe("withCorpusRetryAfter", () => {
  test.each([
    { waitMs: 0, seconds: "1" },
    { waitMs: 1200, seconds: "2" },
    { waitMs: 120_000, seconds: "30" },
  ])("a 503 waits $seconds s for a $waitMs ms queue", ({ waitMs, seconds }) => {
    const response = withCorpusRetryAfter({
      path: SEARCH,
      response: new Response("busy", { status: 503 }),
      waitMs,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(seconds);
  });

  test("any other status is left alone", () => {
    const response = withCorpusRetryAfter({
      path: SEARCH,
      response: new Response("ok", { status: 200 }),
      waitMs: 9000,
    });
    expect(response.headers.has("retry-after")).toBe(false);
  });

  test("a Retry-After the answer already carries wins", () => {
    const response = withCorpusRetryAfter({
      path: SEARCH,
      response: new Response("busy", {
        status: 503,
        headers: { "retry-after": "5" },
      }),
      waitMs: 9000,
    });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  test("a 503 elsewhere on the API is left alone", () => {
    const response = withCorpusRetryAfter({
      path: "/v1/case/decisions/status",
      response: new Response("busy", { status: 503 }),
      waitMs: 9000,
    });
    expect(response.headers.has("retry-after")).toBe(false);
  });
});
