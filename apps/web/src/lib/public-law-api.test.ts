import { describe, expect, test } from "bun:test";

import {
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_UNAVAILABLE_STATUS,
  type PublicCountryCapabilities,
  publicCountryUnavailable,
  publicCountryUnavailableIn,
  publicCountryUnavailableSchema,
} from "@stll/api-contract/public-country-capability";

import { APIError, shouldRetryAPIRequest } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import {
  isPublicLawMiss,
  isSearchUnavailableError,
  publicLawFailureDisposition,
  PublicLawUnavailableError,
  unwrapPublicLawResponse,
} from "@/lib/public-law-api";
import {
  createAppQueryClient,
  CriticalQueryTimeoutError,
} from "@/lib/react-query";

const thrownBy = (status: number, value: unknown): unknown => {
  try {
    unwrapPublicLawResponse(
      { data: null, error: { status, value } },
      "searchPublicCaseLawDecisions",
    );
  } catch (error) {
    return error;
  }
  return null;
};

describe("unwrapPublicLawResponse", () => {
  test("returns the data of a successful response", () => {
    const data = { country: [], court: [], year: [] };
    expect(
      unwrapPublicLawResponse({ data, error: null }, "listPublicCaseLawFacets"),
    ).toBe(data);
  });

  test("names a disabled surface instead of a generic API failure", () => {
    expect(() =>
      unwrapPublicLawResponse(
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
      unwrapPublicLawResponse(
        { data: { error: "Not Found" } as const, error: null },
        "listPublicCaseLawFacets",
      ),
    ).toThrow(PublicLawUnavailableError);
  });

  test("keeps a missing resource on an enabled surface an API error", () => {
    expect(() =>
      unwrapPublicLawResponse(
        { data: null, error: { status: 404, value: { message: "Not found" } } },
        "readPublicCaseLawDecision",
      ),
    ).toThrow(APIError);
  });

  test("keeps every other failure an API error", () => {
    expect(() =>
      unwrapPublicLawResponse(
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
      value: publicCountryUnavailable("USA", {
        domain: "caseLaw",
        surface: "search",
      }),
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
      "Case law for this country is not available. Choose another country.",
    );
  });

  test.each([
    {
      domain: "caseLaw",
      other: "legislation",
      unavailable:
        "Case law for this country is not available. Choose another country.",
      identity:
        "Only exact decision lookup and reading are available for this country.",
      search:
        "Case-law search is not available for this country. You can still read its public decisions.",
    },
    {
      domain: "legislation",
      other: "caseLaw",
      unavailable:
        "Legislation for this country is not available. Choose another country.",
      identity:
        "Only exact legislation lookup and reading are available for this country.",
      search:
        "Legislation search is not available for this country. You can still read its public legislation.",
    },
  ] as const)(
    "$domain refusal preserves the other admitted domain",
    ({ domain, identity, other, unavailable, search }) => {
      for (const reason of publicCountryUnavailableSchema.entries.reason
        .options) {
        const capabilities = {
          ...PUBLIC_COUNTRY_CAPABILITIES,
          EU:
            domain === "caseLaw"
              ? { caseLaw: reason, legislation: "admitted" }
              : { caseLaw: "admitted", legislation: reason },
        } satisfies PublicCountryCapabilities;
        expect(
          publicCountryUnavailableIn({
            capabilities,
            domain: other,
            input: "EU",
            surface: "search",
          }),
        ).toBeNull();
        const refusal = publicCountryUnavailableIn({
          capabilities,
          domain,
          input: "EU",
          surface: "search",
        });
        expect(refusal).toMatchObject({ domain, reason });
        const error = thrownBy(PUBLIC_COUNTRY_UNAVAILABLE_STATUS, refusal);
        expect(APIError.is(error)).toBe(true);
        if (!APIError.is(error)) {
          throw new TypeError("Expected APIError");
        }
        expect(error.details).toMatchObject({ domain, reason, country: "EU" });
        if (reason === "identity_public") {
          expect(error.message).toBe(identity);
          continue;
        }
        expect(error.message).toBe(
          reason === "pages_public" ? search : unavailable,
        );
      }
    },
  );

  test.each([undefined, { provider: "invalid" }])(
    "a refusal without its domain is invalid before provider diagnostic %j",
    (providerDiagnostic) => {
      const error = thrownBy(PUBLIC_COUNTRY_UNAVAILABLE_STATUS, {
        code: "public_country_unavailable",
        status: "unavailable",
        country: "EU",
        reason: "pending_public",
        message: "Unavailable",
        hint: "Choose another country.",
        ...(providerDiagnostic === undefined ? {} : { providerDiagnostic }),
      });
      expect(ClientOperationError.is(error)).toBe(true);
      if (!ClientOperationError.is(error)) {
        throw new TypeError("Expected ClientOperationError");
      }
      expect(error.action).toBe("parse-public-country-unavailable");
      expect(error.message).toBe(
        "Invalid public country unavailability response",
      );
      expect(shouldRetryAPIRequest(0, error)).toBe(false);
    },
  );

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

  test("treats every server failure as a retryable missing result", () => {
    for (let status = 500; status <= 599; status += 1) {
      const error = thrownBy(status, { message: "Internal failure" });
      expect(publicLawFailureDisposition(error), `HTTP ${status}`).toBe(
        "retryable",
      );
      expect(isSearchUnavailableError(error), `HTTP ${status}`).toBe(true);
    }
  });

  test("keeps permanent client responses as deliberate rejections", () => {
    for (let status = 400; status <= 499; status += 1) {
      if (status === 429) {
        continue;
      }
      const error = thrownBy(status, null);
      expect(publicLawFailureDisposition(error), `HTTP ${status}`).toBe(
        "rejected",
      );
      expect(isSearchUnavailableError(error), `HTTP ${status}`).toBe(false);
    }
  });

  test("a disabled public-law surface is not a search outage", () => {
    const error = thrownBy(404, { error: "Not Found" });
    expect(publicLawFailureDisposition(error)).toBe("rejected");
    expect(isSearchUnavailableError(error)).toBe(false);
  });

  test("a read the page stopped waiting for is a search outage", () => {
    expect(
      isSearchUnavailableError(
        new CriticalQueryTimeoutError({
          message: "Critical query timed out after 10000ms",
          queryKey: ["case-law-decisions", "page"],
          timeoutMs: 10_000,
        }),
      ),
    ).toBe(true);
  });

  test("classifies browser transport failures and timeout errors as retryable", () => {
    expect(publicLawFailureDisposition(new TypeError("Failed to fetch"))).toBe(
      "retryable",
    );
    expect(
      publicLawFailureDisposition(
        new Error("Request failed", {
          cause: Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
          }),
        }),
      ),
    ).toBe("retryable");
    expect(
      publicLawFailureDisposition(
        new DOMException("Timed out", "TimeoutError"),
      ),
    ).toBe("retryable");
  });

  test("keeps unrelated programming failures in the render boundary", () => {
    const error = new Error("boom");
    expect(publicLawFailureDisposition(error)).toBe("render");
    expect(isSearchUnavailableError(error)).toBe(false);
  });
});
