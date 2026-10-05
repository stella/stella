import { describe, expect, test } from "bun:test";

import {
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
  publicCountryUnavailable,
} from "@stll/api-contract/public-country-capability";

import { shouldRetryAPIRequest, APIError } from "@/lib/errors/api";
import {
  isPublicLawMiss,
  isSearchUnavailableError,
  PublicLawUnavailableError,
  unwrapPublicLawEden,
} from "@/lib/public-law-api";
import { createAppQueryClient } from "@/lib/react-query";

const thrownBy = (status: number, value: unknown): unknown => {
  try {
    unwrapPublicLawEden(
      { data: null, error: { status, value } },
      "searchPublicCaseLawDecisions",
    );
  } catch (error) {
    return error;
  }
  return null;
};

describe("unwrapPublicLawEden", () => {
  test("returns the data of a successful response", () => {
    const data = { country: [], court: [], year: [] };
    expect(
      unwrapPublicLawEden({ data, error: null }, "listPublicCaseLawFacets"),
    ).toBe(data);
  });

  test("names a disabled surface instead of a generic API failure", () => {
    expect(() =>
      unwrapPublicLawEden(
        {
          data: null,
          error: {
            status: 404,
            value: { error: "Not Found" },
          },
        },
        "listPublicCaseLawFacets",
      ),
    ).toThrow(PublicLawUnavailableError);
  });

  test("a success answer carrying the gate marker is still a disabled surface", () => {
    expect(() =>
      unwrapPublicLawEden(
        { data: { error: "Not Found" } as const, error: null },
        "listPublicCaseLawFacets",
      ),
    ).toThrow(PublicLawUnavailableError);
  });

  test("keeps a missing resource on an enabled surface an API error", () => {
    expect(() =>
      unwrapPublicLawEden(
        { data: null, error: { status: 404, value: { message: "Not found" } } },
        "readPublicCaseLawDecision",
      ),
    ).toThrow(APIError);
  });

  test("keeps every other failure an API error", () => {
    expect(() =>
      unwrapPublicLawEden(
        { data: null, error: { status: 503, value: null } },
        "listPublicCaseLawFacets",
      ),
    ).toThrow(APIError);
  });
});

describe("isSearchUnavailableError", () => {
  test("country admission is localized and never treated as a retryable engine outage or a miss", () => {
    const refusal = {
      status: PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
      value: publicCountryUnavailable("SVK"),
    };
    expect(isPublicLawMiss(refusal, "searchPublicCaseLawDecisions")).toBe(
      false,
    );
    const error = thrownBy(refusal.status, refusal.value);
    expect(APIError.is(error)).toBe(true);
    expect(isSearchUnavailableError(error)).toBe(false);
    expect(shouldRetryAPIRequest(0, error)).toBe(false);
    if (!APIError.is(error)) {
      throw new TypeError("Expected APIError");
    }
    expect(error.code).toBe("public_country_unavailable");
    expect(error.message).toBe(
      "Public law for this country is not available. Choose another country.",
    );
  });

  test("recognizes the engine outage the search endpoint reports", () => {
    expect(
      isSearchUnavailableError(
        thrownBy(503, { message: "Search is temporarily unavailable" }),
      ),
    ).toBe(true);
  });

  test("a corpus at its concurrency limit is a passing outage, not the route's failure", () => {
    const busy = thrownBy(429, { message: "Too many requests" });
    expect(isSearchUnavailableError(busy)).toBe(true);
    expect(shouldRetryAPIRequest(0, busy)).toBe(true);
  });

  test("a final answer is never retried", () => {
    expect(
      shouldRetryAPIRequest(0, thrownBy(422, { message: "Invalid" })),
    ).toBe(false);
  });

  test("a route load that meets a busy corpus once recovers instead of failing", async () => {
    const queryClient = createAppQueryClient();
    let calls = 0;
    const result = await queryClient.query({
      // A loader's fetch: no retry of its own beyond the app default.
      retryDelay: 0,
      queryKey: ["public-law-busy-once"],
      queryFn: async () => {
        calls += 1;
        if (calls === 1) {
          throw thrownBy(429, { message: "Too many requests" });
        }
        return "answered";
      },
    });
    expect(result).toBe("answered");
    expect(calls).toBe(2);
  });

  test("classifies by status, not by the message the API happens to send", () => {
    expect(
      isSearchUnavailableError(
        thrownBy(500, { message: "Search is temporarily unavailable" }),
      ),
    ).toBe(false);
  });

  test("leaves a request the engine refused to the error boundary", () => {
    expect(isSearchUnavailableError(thrownBy(502, null))).toBe(false);
  });

  test("a disabled public-law surface is not a search outage", () => {
    expect(
      isSearchUnavailableError(thrownBy(404, { error: "Not Found" })),
    ).toBe(false);
  });

  test("anything that is not an API failure is not a search outage", () => {
    expect(isSearchUnavailableError(new Error("boom"))).toBe(false);
  });
});
