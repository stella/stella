import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import {
  isSearchUnavailableError,
  PublicLawUnavailableError,
  unwrapPublicLawEden,
} from "@/lib/public-law-api";

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
  test("recognizes the engine outage the search endpoint reports", () => {
    expect(
      isSearchUnavailableError(
        thrownBy(503, { message: "Search is temporarily unavailable" }),
      ),
    ).toBe(true);
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
