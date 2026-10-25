import { expect, test } from "bun:test";
import * as v from "valibot";

import { decisionDateRange } from "@/features/case-law/case-law-index-search.logic";

import { searchSchema } from "./-case-law-search-schema";

// The router reads each URL value as JSON before the schema sees it, so these
// are the values `?year=2026&court=123` actually delivers.
test("reads facets the router parsed as numbers as the text the URL spells", () => {
  const search = v.parse(searchSchema, {
    country: "cze",
    court: 123,
    type: 456,
    year: 2026,
  });

  expect(search).toMatchObject({ court: "123", type: "456", year: "2026" });
  expect(decisionDateRange(search)).toEqual({
    from: "2026-01-01",
    to: "2026-12-31",
  });
});

test("drops an unreadable facet instead of failing the page", () => {
  const search = v.parse(searchSchema, {
    country: "cze",
    court: { nested: true },
    lang: true,
    year: "20266",
  });

  expect(search.court).toBeUndefined();
  expect(search.lang).toBeUndefined();
  expect(search.year).toBeUndefined();
  expect(search.country).toBe("cze");
});
