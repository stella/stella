import { describe, expect, test } from "bun:test";

import {
  isSearchBusy,
  shouldRetrySearch,
  withRetryAfterDetail,
} from "@/features/case-law/search-busy.logic";
import { APIError, apiRetryDelayMs } from "@/lib/errors/api";

const busy = new APIError({
  status: 503,
  message: "busy",
  details: { code: "search_index_unavailable", retryAfterMs: 4000 },
});
const outage = new APIError({ status: 503, message: "down" });

describe("a search the server turned away for now", () => {
  test("is told apart from a 503 with no retry hint", () => {
    expect(isSearchBusy(busy)).toBe(true);
    expect(isSearchBusy(outage)).toBe(false);
  });

  test("is retried once, then fails as before", () => {
    expect(shouldRetrySearch(0, busy)).toBe(true);
    expect(shouldRetrySearch(1, busy)).toBe(false);
  });

  test("waits as long as the server said", () => {
    expect(apiRetryDelayMs(0, busy)).toBe(4000);
  });

  test("other failures keep the shared retry policy and backoff", () => {
    expect(shouldRetrySearch(1, outage)).toBe(true);
    expect(apiRetryDelayMs(2, outage)).toBe(4000);
  });
});

describe("withRetryAfterDetail", () => {
  const refusal = (value: unknown) => ({ status: 503, value });
  const headers = (retryAfter: string) =>
    new Headers({ "retry-after": retryAfter });

  test("carries the header's delay into the refusal's body", () => {
    expect(
      withRetryAfterDetail(refusal({ code: "busy" }), headers("3")).value,
    ).toEqual({ code: "busy", retryAfterMs: 3000 });
  });

  test("leaves a refusal without a usable header alone", () => {
    expect(withRetryAfterDetail(refusal("text"), undefined).value).toBe("text");
    expect(withRetryAfterDetail(refusal("text"), new Headers()).value).toBe(
      "text",
    );
    expect(withRetryAfterDetail(refusal("text"), headers("soon")).value).toBe(
      "text",
    );
  });
});
