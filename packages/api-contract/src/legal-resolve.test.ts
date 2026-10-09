import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { legalResolveResponseSchema } from "./legal-resolve";

describe("legal resolve response", () => {
  test.each([
    {
      status: "resolved",
      document: {
        kind: "decision",
        decisionId: "decision-id",
        identifier: "x",
        country: "CZE",
        caseNumber: "1 A 2/2024",
        ecli: null,
        court: "Court",
        decisionDate: null,
        readerUrl: "https://example.test/decision",
        text: { status: "unavailable" },
      },
    },
    {
      status: "resolved",
      document: {
        kind: "provision",
        documentId: "document-id",
        eli: "https://example.test/eli",
        country: "CZE",
        title: "Act",
        section: "12a",
        readerUrl: "https://example.test/provision",
        inForce: { from: null, to: null },
        versionStatus: "current",
        blocks: [],
      },
    },
    { status: "not_found", reason: "unknown_document" },
    {
      status: "ambiguous",
      candidates: [
        {
          decisionId: "decision-id",
          identifier: "x",
          label: "X",
          readerUrl: "https://example.test/decision",
        },
      ],
    },
    { status: "incomplete_identifier", missing: ["section"] },
    { status: "country_unavailable" },
  ])("accepts the $status envelope", (value) => {
    expect(v.safeParse(legalResolveResponseSchema, value).success).toBe(true);
  });

  test("rejects the former free-form metadata envelope", () => {
    expect(
      v.safeParse(legalResolveResponseSchema, {
        status: "resolved",
        document: {
          identifier: "x",
          country: "CZE",
          metadata: {},
        },
      }).success,
    ).toBe(false);
  });
});
