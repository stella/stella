import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { parseCaseLawResearchSavedQuery } from "@/api/lib/case-law/research-saved-query";

const isoDate = fc
  .date({
    min: new Date("1900-01-01T00:00:00Z"),
    max: new Date("2100-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));

const filterText = (maxLength: number) =>
  fc
    .string({ minLength: 1, maxLength })
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const validQuery = fc.record(
  {
    version: fc.constant(1 as const),
    query: filterText(200),
    country: filterText(3),
    court: filterText(64),
    dateFrom: isoDate,
    dateTo: isoDate,
    decisionType: filterText(32),
    language: filterText(8),
    sourceId: fc.uuid(),
  },
  { requiredKeys: ["version", "query"] },
);

describe("research table saved query", () => {
  test("accepts every well-formed query and keeps its filters", () => {
    fc.assert(
      fc.property(validQuery, (input) => {
        const parsed = parseCaseLawResearchSavedQuery(input);
        expect(Result.isOk(parsed)).toBe(true);
        if (Result.isOk(parsed)) {
          expect(parsed.value).toEqual(input);
        }
      }),
      propertyConfig(),
    );
  });

  test("trims the words and refuses a query that is only whitespace", () => {
    const padded = parseCaseLawResearchSavedQuery({
      version: 1,
      query: "  nájemní smlouva  ",
    });
    expect(Result.isOk(padded) && padded.value.query).toBe("nájemní smlouva");

    const blank = parseCaseLawResearchSavedQuery({ version: 1, query: "   " });
    expect(Result.isError(blank)).toBe(true);
  });

  test("refuses unknown keys, other versions and malformed filters", () => {
    fc.assert(
      fc.property(
        validQuery,
        fc.constantFrom(
          { extra: "x" },
          { version: 2 },
          { dateFrom: "2024-13-01" },
          { sourceId: "not-a-uuid" },
          { country: "" },
        ),
        (input, corruption) => {
          const parsed = parseCaseLawResearchSavedQuery({
            ...input,
            ...corruption,
          });
          expect(Result.isError(parsed)).toBe(true);
        },
      ),
      propertyConfig(),
    );
  });
});
