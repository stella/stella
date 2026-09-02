import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import {
  PublicLawUnavailableError,
  unwrapPublicLawEden,
} from "@/lib/public-law-api";

describe("unwrapPublicLawEden", () => {
  test("returns the data of a successful response", () => {
    const data = { country: [], court: [], year: [] };
    expect(
      unwrapPublicLawEden({ data, error: null }, "listPublicCaseLawFacets"),
    ).toBe(data);
  });

  test("names a disabled surface instead of a generic API failure", () => {
    // The gate body is `{ error: "Not Found" }` alone; the contract type
    // insists on a message, which the marker check ignores.
    expect(() =>
      unwrapPublicLawEden(
        {
          data: null,
          error: {
            status: 404,
            value: { error: "Not Found", message: "Not Found" },
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
