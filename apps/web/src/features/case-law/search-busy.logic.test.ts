import { describe, expect, test } from "bun:test";

import {
  isSearchBusy,
  retryAfterMsFrom,
  searchRetryDelayMs,
  shouldRetrySearch,
  withRetryAfterDetail,
} from "@/features/case-law/search-busy.logic";
import { APIError } from "@/lib/errors/api";

const busy = new APIError({
  status: 503,
  message: "busy",
  details: withRetryAfterDetail({ code: "search_index_unavailable" }, 4000),
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
    expect(searchRetryDelayMs(0, busy)).toBe(4000);
  });

  test("other failures keep the shared retry policy and backoff", () => {
    expect(shouldRetrySearch(1, outage)).toBe(true);
    expect(searchRetryDelayMs(2, outage)).toBe(4000);
  });
});

describe("retryAfterMsFrom", () => {
  test("reads seconds, and nothing else", () => {
    expect(retryAfterMsFrom(new Headers({ "retry-after": "3" }))).toBe(3000);
    expect(retryAfterMsFrom(new Headers())).toBeUndefined();
    expect(
      retryAfterMsFrom(new Headers({ "retry-after": "soon" })),
    ).toBeUndefined();
  });
});
