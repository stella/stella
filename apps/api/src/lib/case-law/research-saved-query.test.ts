import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { SEARCH_SORTS } from "@stll/api-contract/search";
import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
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
    sourceId: fc.uuid().map((id) => toSafeId<"caseLawSource">(id)),
    sort: fc.constantFrom(...SEARCH_SORTS),
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

/**
 * A table saved under an order has to re-run under it: the rows a reader kept
 * working on are the first page of that ranking, and re-running the other one
 * silently replaces them.
 */
describe("the saved order", () => {
  test.each([...SEARCH_SORTS])("round-trips %s", (sort) => {
    const parsed = parseCaseLawResearchSavedQuery({
      version: 1,
      query: "promlčení",
      sort,
    });

    expect(Result.isError(parsed) ? null : parsed.value.sort).toBe(sort);
  });

  // Absent is the default, and is what every table saved before the order
  // existed carries.
  test("stays absent when the table never named one", () => {
    const parsed = parseCaseLawResearchSavedQuery({
      version: 1,
      query: "promlčení",
    });

    expect(Result.isError(parsed) ? "error" : "sort" in parsed.value).toBe(
      false,
    );
  });

  test.each(["oldest", "RELEVANCE", "", null, 1])(
    "rejects the undeclared order %p",
    (sort) => {
      expect(
        Result.isError(
          parseCaseLawResearchSavedQuery({
            version: 1,
            query: "promlčení",
            sort,
          }),
        ),
      ).toBe(true);
    },
  );
});
