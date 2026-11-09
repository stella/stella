import { describe, expect, test } from "bun:test";

import { withCorpusRetryAfter } from "@/api/lib/legal-search/corpus-retry-after";

describe("withCorpusRetryAfter", () => {
  test.each([
    { waitMs: 0, seconds: "1" },
    { waitMs: 1200, seconds: "2" },
    { waitMs: 120_000, seconds: "30" },
  ])("a 503 waits $seconds s for a $waitMs ms queue", ({ waitMs, seconds }) => {
    const response = withCorpusRetryAfter(
      new Response("busy", { status: 503 }),
      waitMs,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(seconds);
  });

  test("any other status is left alone", () => {
    const response = withCorpusRetryAfter(
      new Response("ok", { status: 200 }),
      9000,
    );
    expect(response.headers.has("retry-after")).toBe(false);
  });

  test("a Retry-After the answer already carries wins", () => {
    const response = withCorpusRetryAfter(
      new Response("busy", { status: 503, headers: { "retry-after": "5" } }),
      9000,
    );
    expect(response.headers.get("retry-after")).toBe("5");
  });
});
