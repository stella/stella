import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { legislationQueryFingerprint } from "@/api/handlers/legislation/search";
import type { SearchLegislationBody } from "@/api/handlers/legislation/search-schema";
import { createSafeId } from "@/api/lib/branded-types";

type SearchFilters = Omit<SearchLegislationBody, "query" | "limit" | "cursor">;
const filterArbitraries = {
  jurisdiction: fc.constantFrom("CZE", "SVK", "EU"),
  documentType: fc.string({ minLength: 1, maxLength: 128 }),
  status: fc.string({ minLength: 1, maxLength: 32 }),
  source: fc.constantFrom(
    createSafeId<"legislationSource">(),
    createSafeId<"legislationSource">(),
  ),
  language: fc.constantFrom("cs", "sk", "en"),
  dateFrom: fc
    .integer({ min: 2000, max: 2025 })
    .map((year) => `${String(year)}-01-01`),
  dateTo: fc
    .integer({ min: 2000, max: 2025 })
    .map((year) => `${String(year)}-12-31`),
} satisfies {
  [Field in keyof SearchFilters]-?: fc.Arbitrary<
    NonNullable<SearchFilters[Field]>
  >;
};

test("each search filter independently changes the actual cursor fingerprint", () => {
  assertProperty(
    "each search filter independently changes the actual cursor fingerprint",
    fc.property(fc.record(filterArbitraries), (filters) => {
      const body = { query: "náhrada škody" };
      const unfiltered = legislationQueryFingerprint(body);
      for (const [field, value] of Object.entries(filters)) {
        expect(value).not.toBeUndefined();
        expect(
          legislationQueryFingerprint({ ...body, [field]: value }),
        ).not.toBe(unfiltered);
        const withoutFilter = Object.fromEntries(
          Object.entries(filters).filter(([candidate]) => candidate !== field),
        );
        expect(legislationQueryFingerprint({ ...body, ...filters })).not.toBe(
          legislationQueryFingerprint({ ...body, ...withoutFilter }),
        );
      }
    }),
  );
});

test("the query changes its cursor fingerprint while pagination fields do not", () => {
  assertProperty(
    "the query changes its cursor fingerprint while pagination fields do not",
    fc.property(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.integer({ min: 1, max: 100 }),
      (query, limit) => {
        const fingerprint = legislationQueryFingerprint({ query });
        expect(
          legislationQueryFingerprint({ query: `${query} další` }),
        ).not.toBe(fingerprint);
        expect(
          legislationQueryFingerprint({ query, limit, cursor: "page" }),
        ).toBe(fingerprint);
      },
    ),
  );
});
