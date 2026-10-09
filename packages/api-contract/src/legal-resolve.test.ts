import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { legalResolveResponseSchema } from "./legal-resolve";

describe("legal resolve response", () => {
  test.each([
    {
      status: "resolved",
      document: { identifier: "x", country: "CZE", metadata: {} },
    },
    { status: "not_found", reason: "unknown_document" },
    { status: "ambiguous", candidates: [{ identifier: "x", label: "X" }] },
    { status: "incomplete_identifier", missing: ["section"] },
    { status: "country_unavailable" },
  ])("accepts the $status envelope", (value) => {
    expect(v.safeParse(legalResolveResponseSchema, value).success).toBe(true);
  });

  test("rejects a resolved document that returns restricted text", () => {
    expect(
      v.safeParse(legalResolveResponseSchema, {
        status: "resolved",
        document: {
          identifier: "x",
          country: "CZE",
          metadata: {},
          text: "restricted",
          textWithheld: "licence",
        },
      }).success,
    ).toBe(false);
  });
});
